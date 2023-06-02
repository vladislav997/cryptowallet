import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { catchError, map, of } from 'rxjs';
import axios from 'axios';
import { validate } from 'bitcoin-address-validation';
import {
  convertFromSatoshi,
  convertToSatoshi,
} from '../../common/helper/helper.function';
import * as bitcoin from 'bitcoinjs-lib';

@Injectable()
export class BtcServiceV1 {
  private apiBlockcypherUrl = 'https://api.blockcypher.com/v1/btc/main';
  private apiBlockchairUrl = 'https://api.blockchair.com/bitcoin';

  constructor(private readonly httpService: HttpService) {}

  getAddressFromPrivateKey(privateKey) {
    // WIF (Wallet Import Format)
    // const keyPair = bitcoin.ECPair.fromPrivateKey(
    //   Buffer.from(privateKey, 'hex'),
    // );

    // HEX format
    const keyPair = bitcoin.ECPair.fromWIF(privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey });
    return address;
  }

  async calculateAverageFee() {
    try {
      const response = await this.httpService
        .get('https://bitcoinfees.earn.com/api/v1/fees/recommended')
        .toPromise();

      return response.data.hourFee;
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }

  async getPreviousTransactionHashAndOutputIndex(address, amount) {
    try {
      const response = await axios.get(
        this.apiBlockcypherUrl + `/addrs/${address}/full`,
      );
      const data = response.data;

      if (data.txs.length === 0) {
        throw new HttpException(
          'No previous transactions found',
          HttpStatus.BAD_REQUEST,
        );
      }

      // получаем последнюю предыдущую транзакцию
      const previousTransaction = data.txs[data.txs.length - 1];

      // ищем выход, который содержит указанный адрес
      const previousOutput = previousTransaction.outputs.find((output) =>
        output.addresses.includes(address),
      );

      // проверяем, найден ли предыдущий выход
      if (!previousOutput) {
        throw new HttpException(
          'Previous output not found',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        previousTransactionHash: previousTransaction.hash,
        previousOutputIndex:
          previousTransaction.outputs.indexOf(previousOutput),
      };
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }

  async create() {
    try {
      // генерируем Private Key
      const keyPair = bitcoin.ECPair.makeRandom({
        network: bitcoin.networks.bitcoin,
      });
      const privateKey = keyPair.toWIF();

      // получаем Public Key из Private Key
      const publicKey = keyPair.publicKey.toString('hex');

      // получаем адрес из Public Key
      const { address } = bitcoin.payments.p2pkh({
        pubkey: keyPair.publicKey,
        network: bitcoin.networks.bitcoin,
      });

      return {
        status: true,
        data: {
          address: address,
          privateKey: privateKey,
          publicKey: publicKey,
        },
      };
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }

  async balance(balanceBtcDto) {
    try {
      const address = balanceBtcDto.address;

      if (!validate(address)) {
        throw new HttpException('Incorrect address', HttpStatus.BAD_REQUEST);
      }

      const url = this.apiBlockchairUrl + '/dashboards/address/' + address;
      const response = await axios.get(url, {
        params: {
          key: process.env.BLOCKCHAIR_APIKEY,
        },
      });
      const balanceData = response.data.data[address]?.address || null;

      const balance = balanceData.balance;

      return {
        status: true,
        data: convertFromSatoshi(balance),
      };
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }

  async send(sendBtcDto) {
    try {
      const address = this.getAddressFromPrivateKey(sendBtcDto.private_key);
      const toAddress = sendBtcDto.to_address;
      const feePerByte = sendBtcDto.fee || (await this.calculateAverageFee());

      if (!validate(toAddress)) {
        throw new HttpException(
          'Incorrect recipient address',
          HttpStatus.BAD_REQUEST,
        );
      }

      // получаем хэш предыдущей транзакции и индекс выхода, связанные с указанным адресом
      const { previousTransactionHash, previousOutputIndex } =
        await this.getPreviousTransactionHashAndOutputIndex(
          address,
          sendBtcDto.amount,
        );

      if (previousOutputIndex === undefined) {
        throw new HttpException(
          'Previous output index is undefined',
          HttpStatus.BAD_REQUEST,
        );
      }

      // ------------------------------ //
      //     создание транзакции        //
      // ------------------------------ //
      // создаем транзакцию на основе TransactionBuilder
      const txb = new bitcoin.TransactionBuilder(bitcoin.networks.bitcoin);
      const privateKeyBuffer = bitcoin.ECPair.fromWIF(
        sendBtcDto.private_key,
      ).privateKey;

      // добавляем вход в транзакцию, используя хэш предыдущей транзакции и индекс выхода
      txb.addInput(previousTransactionHash, previousOutputIndex);

      // добавляем выходную точку для отправки средств на указанный адрес и конвертируем сумму в сатоши
      txb.addOutput(toAddress, convertToSatoshi(sendBtcDto.amount));

      // подписываем входную точку транзакции с помощью приватного ключа
      txb.sign(0, bitcoin.ECPair.fromPrivateKey(privateKeyBuffer));

      // создаем полную транзакцию
      const builtTransaction = txb.build();

      // ------------------------------ //
      //   расчет и установка комиссии  //
      // ------------------------------ //
      // рассчитываем размер транзакции в байтах
      const transactionSize = builtTransaction.byteLength();

      // рассчитываем общую комиссию в сатоши
      const calculateFee = feePerByte * transactionSize;

      // проверяем, что выход с указанным индексом существует
      if (previousOutputIndex >= builtTransaction.outs.length) {
        throw new HttpException(
          `Output with index ${previousOutputIndex} does not exist.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // устанавливаем комиссию для выхода с указанным индексом
      builtTransaction.outs[previousOutputIndex].value = calculateFee;

      // получаем шестнадцатеричное представление транзакции
      const hexTransaction = builtTransaction.toHex();

      // используем ранее рассчитанный calculateFee для каждого выхода
      const totalFeePerOutput = calculateFee;

      // рассчитываем комиссию для всех входов
      const totalFeePerInput = feePerByte * builtTransaction.ins.length;

      // рассчитываем общую комиссию
      const totalFee = totalFeePerOutput + totalFeePerInput;

      // получаем сумму комиссии и кол-ва отправляемых биткоинов
      const totalPay = convertFromSatoshi(totalFee) + sendBtcDto.amount;

      // приводим общую сумму платежа в числовой формат
      const totalPayFormat = parseFloat(totalPay);

      // получаем баланс пользователя с учетом неподтвержденных транзакций
      const userBalance = await this.balance({ address });

      // проверяем баланс пользователя
      if (userBalance.data < totalPayFormat) {
        throw new HttpException(
          'Insufficient coin balance',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return this.httpService
        .post(this.apiBlockchairUrl + '/push/transaction', {
          data: hexTransaction,
        })
        .pipe(
          map((response) => {
            return {
              is_success_transaction: true,
              transaction_id: response.data.hash,
              from: address,
              to: sendBtcDto.to_address,
              value: String(sendBtcDto.amount),
              timestamp: String(Date.now()),
            };
          }),
          catchError((error) => {
            const errorMessage = error.response.data.context.error.toString();

            if (
              errorMessage == 'Invalid transaction. Error: txn-mempool-conflict'
            ) {
              return of({
                status: false,
                message:
                  'You have an incomplete transaction. Wait until the previous transaction is completed',
              });
            }
            return of({
              status: false,
              message: errorMessage,
            });
          }),
        );
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }

  async transaction(transactionBtcDto) {
    try {
      const url =
        this.apiBlockchairUrl +
        '/dashboards/transaction/' +
        transactionBtcDto.hash;

      const response = await axios.get(url, {
        params: {
          key: process.env.BLOCKCHAIR_APIKEY,
        },
      });
      const transactionData = response.data.data[transactionBtcDto.hash];
      const transaction = transactionData.transaction;
      const input = transactionData.inputs[0];
      const output = transactionData.outputs[0];

      return {
        status: true,
        data: {
          is_success_transaction: transaction.block_id !== -1,
          transaction_id: transaction.hash,
          from: input.recipient,
          to: output.recipient,
          value: convertFromSatoshi(output.value),
          fee: convertFromSatoshi(transaction.fee),
          timestamp: new Date(transaction.time).getTime(),
        },
      };
    } catch (e) {
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async transactions(transactionsBtcDto) {
    try {
      const address = transactionsBtcDto.address;

      if (!validate(address)) {
        throw new HttpException('Incorrect address', HttpStatus.BAD_REQUEST);
      }

      const url = this.apiBlockchairUrl + '/dashboards/address/' + address;

      const response = await axios.get(url, {
        params: {
          key: process.env.BLOCKCHAIR_APIKEY,
        },
      });
      const data = response.data.data[address];

      if (!data) {
        throw new HttpException('Address not found', HttpStatus.BAD_REQUEST);
      }

      const transactions = data.transactions;
      const transactionList = [];

      for (const hash of transactions) {
        const transactionData = await this.transaction({ hash });
        const transaction = transactionData.data;

        transactionList.push({
          ...transaction,
        });
      }

      return {
        status: true,
        data: transactionList,
      };
    } catch (e) {
      throw new HttpException(
        {
          message: e.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          cause: e,
        },
      );
    }
  }
}