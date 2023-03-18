import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { getAddressByPrivateKey } from '../common/helper/helper.function';
import contractJson from '../common/helper/contract-json';
const Web3 = require('web3');

@Injectable()
export class Web3Service {
  async getContractDecimal(web3, contract) {
    const getContract = new web3.eth.Contract(contractJson(), contract);
    return await getContract.methods.decimals().call();
  }

  async balanceCall(web3, contract, address) {
    const getContract = new web3.eth.Contract(contractJson(), contract);
    return await getContract.methods.balanceOf(address).call();
  }

  async calculateEstimateGasFees(web3, amount, address, dto) {
    let usedGasLimit = dto.gas_limit;
    let estimateGas;
    const gasPrice = await web3.eth.getGasPrice();
    let gasFees = Number(usedGasLimit) * Number(gasPrice);
    const contract = new web3.eth.Contract(contractJson(), dto.contract);

    if (Number(usedGasLimit) > 0) {
      gasFees = Number(usedGasLimit) * Number(gasPrice);
    } else {
      estimateGas = await contract.methods
        .transfer(dto.to_address, amount)
        .estimateGas({ from: address });
      usedGasLimit = parseInt(String(estimateGas / 2)) + estimateGas;
    }

    const finalGasFees = Web3.utils.fromWei(gasFees.toString());

    return {
      amount: amount,
      tx: 'ok',
      gasLimit: usedGasLimit,
      gasPrice: gasPrice,
      estimateGasFees: finalGasFees,
    };
  }

  async create(chainLink) {
    try {
      const connectWeb3 = new Web3(new Web3.providers.HttpProvider(chainLink));

      const wallet = await connectWeb3.eth.accounts.create();

      return {
        status: true,
        data: wallet,
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

  async balance(chainLink, balanceWeb3Dto) {
    try {
      let balance;
      const web3 = new Web3(chainLink);
      const validateAddress = new Web3().utils.isAddress(
        balanceWeb3Dto.address,
      );

      if (validateAddress) {
        if (balanceWeb3Dto.type == 'coin') {
          const getBalance = await web3.eth.getBalance(balanceWeb3Dto.address);

          balance = parseFloat(
            web3.utils.fromWei(getBalance.toString(), 'ether'),
          );
        }

        if (balanceWeb3Dto.type == 'token') {
          const validateContract = new Web3().utils.isAddress(
            balanceWeb3Dto.contract,
          );

          if (validateContract) {
            const decimal = await this.getContractDecimal(
              web3,
              balanceWeb3Dto.contract,
            );
            const balanceCall = await this.balanceCall(
              web3,
              balanceWeb3Dto.contract,
              balanceWeb3Dto.address,
            );

            balance = balanceCall / Math.pow(10, decimal);
          } else {
            throw new HttpException(
              'Incorrect contract address',
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        return {
          status: true,
          data: balance,
        };
      } else {
        throw new HttpException('Incorrect address', HttpStatus.BAD_REQUEST);
      }
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

  async send(chainLink, chainId, sendWeb3Dto) {
    try {
      let transaction;
      const web3 = new Web3(chainLink);
      const address = getAddressByPrivateKey(web3, sendWeb3Dto.private_key);
      const validateRecipientAddress = new Web3().utils.isAddress(
        sendWeb3Dto.to_address,
      );

      if (validateRecipientAddress) {
        if (sendWeb3Dto.type == 'coin') {
          const amount = Web3.utils.toWei(
            sendWeb3Dto.amount.toString(),
            'ether',
          );
          const nonce = await web3.eth.getTransactionCount(address, 'latest');
          const usedGasLimit =
            sendWeb3Dto.gas_limit > 0 ? sendWeb3Dto.gas_limit : 63000;

          transaction = {
            from: address,
            nonce: web3.utils.toHex(nonce),
            gas: usedGasLimit,
            to: sendWeb3Dto.to_address,
            value: amount,
            chainId: chainId,
          };
        }

        if (sendWeb3Dto.type == 'token') {
          const validateContract = new Web3().utils.isAddress(
            sendWeb3Dto.contract,
          );
          if (validateContract) {
            const decimal = await this.getContractDecimal(
              web3,
              sendWeb3Dto.contract,
            );

            const amount = (
              sendWeb3Dto.amount * Math.pow(10, decimal)
            ).toLocaleString('fullwide', { useGrouping: false });

            const calculateEstimateGasFees =
              await this.calculateEstimateGasFees(
                web3,
                amount,
                address,
                sendWeb3Dto,
              );
            const contract = new web3.eth.Contract(
              contractJson(),
              sendWeb3Dto.contract,
            );

            transaction = {
              from: address,
              to: sendWeb3Dto.contract,
              gas: calculateEstimateGasFees.gasLimit,
              data: contract.methods
                .transfer(sendWeb3Dto.to_address, amount)
                .encodeABI(),
            };
          } else {
            throw new HttpException(
              'Incorrect contract address',
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        const signTransaction = await web3.eth.accounts.signTransaction(
          transaction,
          sendWeb3Dto.private_key,
        );
        const receipt = await new Promise((resolve, reject) =>
          web3.eth
            .sendSignedTransaction(signTransaction.rawTransaction)
            .on('receipt', resolve)
            .on('error', reject),
        );

        return {
          status: true,
          data: receipt,
        };
      } else {
        throw new HttpException(
          'Incorrect recipient address',
          HttpStatus.BAD_REQUEST,
        );
      }
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
