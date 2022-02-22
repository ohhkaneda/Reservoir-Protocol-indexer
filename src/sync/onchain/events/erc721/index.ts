import { Interface, LogDescription } from "@ethersproject/abi";
import { Log } from "@ethersproject/abstract-provider";

import { logger } from "@/common/logger";
import { config } from "@/config/index";
import {
  NftApprovalEvent,
  addNftApprovalEvents,
  removeNftApprovalEvents,
} from "@/events/common/nft-approvals";
import {
  NftTransferEvent,
  addNftTransferEvents,
  removeNftTransferEvents,
} from "@/events/common/nft-transfers";
import { ContractInfo } from "@/events/index";
import { parseEvent } from "@/events/parser";
import { MakerInfo, addToOrdersUpdateByMakerQueue } from "@/jobs/orders-update";

const abi = new Interface([
  `event Transfer(
    address indexed from,
    address indexed to,
    uint256 indexed tokenId
  )`,
  `event ApprovalForAll(
    address indexed owner,
    address indexed operator,
    bool approved
  )`,
]);

// Some old contracts might use a non-standard `Transfer` event
// which is exactly the same as the standard one, but it misses
// the index on the `tokenId` field.
const nonStandardAbi = new Interface([
  `event Transfer(
    address indexed from,
    address indexed to,
    uint256 tokenId
  )`,
]);

export const getContractInfo = (address: string[] = []): ContractInfo => ({
  filter: { address },
  syncCallback: async (logs: Log[], backfill?: boolean) => {
    const approvalEvents: NftApprovalEvent[] = [];
    const transferEvents: NftTransferEvent[] = [];
    const makerInfos: MakerInfo[] = [];

    for (const log of logs) {
      try {
        const baseParams = parseEvent(log);
        const context =
          baseParams.txHash + "-" + baseParams.logIndex.toString();

        switch (log.topics[0]) {
          case abi.getEventTopic("Transfer"): {
            let parsedLog: LogDescription;
            try {
              parsedLog = abi.parseLog(log);
            } catch {
              parsedLog = nonStandardAbi.parseLog(log);
            }
            const from = parsedLog.args.from.toLowerCase();
            const to = parsedLog.args.to.toLowerCase();
            const tokenId = parsedLog.args.tokenId.toString();
            const amount = "1";

            transferEvents.push({
              tokenId,
              from,
              to,
              amount,
              baseParams,
            });

            makerInfos.push({
              context,
              side: "sell",
              maker: from,
              contract: baseParams.address,
              tokenId,
            });
            makerInfos.push({
              context,
              side: "sell",
              maker: to,
              contract: baseParams.address,
              tokenId,
            });

            break;
          }

          case abi.getEventTopic("ApprovalForAll"): {
            const parsedLog = abi.parseLog(log);
            const owner = parsedLog.args.owner.toLowerCase();
            const operator = parsedLog.args.operator.toLowerCase();
            const approved = parsedLog.args.approved;

            approvalEvents.push({
              owner,
              operator,
              approved,
              baseParams,
            });

            makerInfos.push({
              context,
              side: "sell",
              maker: owner,
              contract: baseParams.address,
              operator,
              approved,
              checkApproval: true,
            });

            break;
          }
        }
      } catch (error) {
        logger.error("erc721_callback", `Could not parse log ${log}: ${error}`);
      }
    }

    await addNftApprovalEvents(approvalEvents);
    await addNftTransferEvents(transferEvents);
    if (!backfill && config.acceptOrders) {
      await addToOrdersUpdateByMakerQueue(makerInfos);
    }
  },
  fixCallback: async (blockHash) => {
    await removeNftApprovalEvents(blockHash);
    await removeNftTransferEvents(blockHash);
  },
});
