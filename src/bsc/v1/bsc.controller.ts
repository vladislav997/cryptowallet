import { Controller, Post, Body, ValidationPipe } from '@nestjs/common';
import { Web3Service } from '../../web3/web3.service';
import { BalanceWeb3Dto } from '../../web3/dto/balance-web3.dto';
import { SendWeb3Dto } from '../../web3/dto/send-web3.dto';

@Controller({
  path: 'bsc',
  version: '1',
})
export class BscControllerV1 {
  constructor(private readonly web3Service: Web3Service) {}

  @Post('/create')
  create() {
    return this.web3Service.create(process.env.CHAIN_LINK_BSC);
  }

  @Post('/balance')
  balance(@Body(new ValidationPipe()) balanceWeb3Dto: BalanceWeb3Dto) {
    return this.web3Service.balance(process.env.CHAIN_LINK_BSC, balanceWeb3Dto);
  }

  @Post('/send')
  send(@Body(new ValidationPipe({ transform: true })) sendWeb3Dto: SendWeb3Dto) {
    return this.web3Service.send(process.env.CHAIN_LINK_BSC, process.env.CHAIN_ID_BSC, sendWeb3Dto);
  }
}
