import {
    assetDataUtils,
    BigNumber,
    ContractWrappers,
    generatePseudoRandomSalt,
    Order,
    orderHashUtils,
    signatureUtils,
    SignerType,
} from '0x.js';
import { HttpClient, OrderbookRequest } from '@0xproject/connect';
import { Web3Wrapper } from '@0xproject/web3-wrapper';

import { NETWORK_ID, NULL_ADDRESS, TEN_MINUTES, TX_DEFAULTS, ZERO } from '../constants';
import { providerEngine } from '../contracts';
import { PrintUtils } from '../print_utils';

/**
 * In this scenario, the maker creates and signs an order for selling ZRX for WETH. This
 * order is then submitted to a Relayer via the Standard Relayer API. A Taker queries
 * this Standard Relayer API to discover orders.
 * The taker fills this order via the 0x Exchange contract.
 */
export async function scenario(): Promise<void> {
    PrintUtils.printScenario('Fill Order Standard Relayer API');
    // Initialize the ContractWrappers, this provides helper functions around calling
    // contracts on the blockchain
    const contractWrappers = new ContractWrappers(providerEngine, { networkId: NETWORK_ID });
    // Initialize the Web3Wraper, this provides helper functions around calling
    // account information, balances, general contract logs
    const web3Wrapper = new Web3Wrapper(providerEngine);
    const [maker, taker] = await web3Wrapper.getAvailableAddressesAsync();
    const zrxTokenAddress = contractWrappers.exchange.getZRXTokenAddress();
    const etherTokenAddress = contractWrappers.etherToken.getContractAddressIfExists();
    if (!etherTokenAddress) {
        throw new Error('Ether Token not found on this network');
    }
    const printUtils = new PrintUtils(
        web3Wrapper,
        contractWrappers,
        { maker, taker },
        { WETH: etherTokenAddress, ZRX: zrxTokenAddress },
    );
    printUtils.printAccounts();

    const makerAssetData = assetDataUtils.encodeERC20AssetData(zrxTokenAddress);
    const takerAssetData = assetDataUtils.encodeERC20AssetData(etherTokenAddress);
    // the amount the maker is selling in maker asset
    const makerAssetAmount = new BigNumber(100);
    // the amount the maker is wanting in taker asset
    const takerAssetAmount = new BigNumber(10);

    let txHash;
    let txReceipt;

    // Approve the ERC20 Proxy to move ZRX for makerAccount
    const makerZRXApprovalTxHash = await contractWrappers.erc20Token.setUnlimitedProxyAllowanceAsync(
        zrxTokenAddress,
        maker,
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Maker ZRX Approval', makerZRXApprovalTxHash);

    // Approve the ERC20 Proxy to move WETH for takerAccount
    const takerWETHApprovalTxHash = await contractWrappers.erc20Token.setUnlimitedProxyAllowanceAsync(
        etherTokenAddress,
        taker,
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Approval', takerWETHApprovalTxHash);

    // Deposit ETH into WETH for the taker
    const takerWETHDepositTxHash = await contractWrappers.etherToken.depositAsync(
        etherTokenAddress,
        takerAssetAmount,
        taker,
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Deposit', takerWETHDepositTxHash);

    PrintUtils.printData('Setup', [
        ['Maker ZRX Approval', makerZRXApprovalTxHash],
        ['Taker WETH Approval', takerWETHApprovalTxHash],
        ['Taker WETH Deposit', takerWETHDepositTxHash],
    ]);

    // Set up the Order and fill it
    const randomExpiration = new BigNumber(Date.now() + TEN_MINUTES);
    const exchangeAddress = contractWrappers.exchange.getContractAddress();

    // Create the order
    const order: Order = {
        exchangeAddress,
        makerAddress: maker,
        takerAddress: NULL_ADDRESS,
        senderAddress: NULL_ADDRESS,
        feeRecipientAddress: NULL_ADDRESS,
        expirationTimeSeconds: randomExpiration,
        salt: generatePseudoRandomSalt(),
        makerAssetAmount,
        takerAssetAmount,
        makerAssetData,
        takerAssetData,
        makerFee: ZERO,
        takerFee: ZERO,
    };

    // Generate the order hash and sign the order
    const orderHashHex = orderHashUtils.getOrderHashHex(order);
    const signature = await signatureUtils.ecSignOrderHashAsync(
        providerEngine,
        orderHashHex,
        maker,
        SignerType.Default,
    );
    const signedOrder = { ...order, signature };

    // Create a HTTP Client to query the SRA Endpoint
    const httpClient = new HttpClient('http://localhost:3000/v2/');
    await httpClient.submitOrderAsync(signedOrder, { networkId: NETWORK_ID });

    // Taker queries the Orderbook from the Relayer
    const orderbookRequest: OrderbookRequest = { baseAssetData: makerAssetData, quoteAssetData: takerAssetData };
    const response = await httpClient.getOrderbookAsync(orderbookRequest, { networkId: NETWORK_ID });
    if (response.asks.total === 0) {
        throw new Error('No orders found on the SRA Endpoint');
    }
    const sraOrder = response.asks.records[0].order;
    printUtils.printOrder(sraOrder);

    // Fill the Order via 0x Exchange contract
    txHash = await contractWrappers.exchange.fillOrderAsync(sraOrder, takerAssetAmount, taker, {
        gasLimit: TX_DEFAULTS.gas,
    });
    txReceipt = await printUtils.awaitTransactionMinedSpinnerAsync('fillOrder', txHash);
    printUtils.printTransaction('fillOrder', txReceipt, [['orderHash', orderHashHex]]);

    // Print the Balances
    await printUtils.fetchAndPrintContractBalancesAsync();

    // Stop the Provider Engine
    providerEngine.stop();
}

void (async () => {
    try {
        if (!module.parent) {
            await scenario();
        }
    } catch (e) {
        console.log(e);
        providerEngine.stop();
    }
})();