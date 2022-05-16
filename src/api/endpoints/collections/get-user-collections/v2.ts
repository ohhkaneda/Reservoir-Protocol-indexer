/* eslint-disable @typescript-eslint/no-explicit-any */
import _ from "lodash";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { edb } from "@/common/db";
import { logger } from "@/common/logger";
import { formatEth, fromBuffer, toBuffer } from "@/common/utils";

const version = "v2";

export const getUserCollectionsV2Options: RouteOptions = {
  description: "Get aggregate stats for a user, grouped by collection",
  notes:
    "Get aggregate stats for a user, grouped by collection. Useful for showing total portfolio information.",
  tags: ["api", "4. NFT API"],
  plugins: {
    "hapi-swagger": {
      order: 32,
    },
  },
  validate: {
    params: Joi.object({
      user: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .required()
        .description("Wallet to see results for e.g. `0xf296178d553c8ec21a2fbd2c5dda8ca9ac905a00`"),
    }),
    query: Joi.object({
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community, e.g. `artblocks`"),
      collection: Joi.string()
        .lowercase()
        .description(
          "Filter to a particular collection, e.g. `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
        ),
      includeTopBid: Joi.boolean().default(false),
      offset: Joi.number().integer().min(0).max(10000).default(0),
      limit: Joi.number().integer().min(1).max(100).default(20),
    }),
  },
  response: {
    schema: Joi.object({
      collections: Joi.array().items(
        Joi.object({
          collection: Joi.object({
            id: Joi.string(),
            slug: Joi.string(),
            name: Joi.string().allow(null, ""),
            image: Joi.string().allow(null, ""),
            banner: Joi.string().allow(null, ""),
            discordUrl: Joi.string().allow(null, ""),
            externalUrl: Joi.string().allow(null, ""),
            twitterUsername: Joi.string().allow(null, ""),
            description: Joi.string().allow(null, ""),
            sampleImages: Joi.array().items(Joi.string().allow(null, "")),
            tokenCount: Joi.string(),
            tokenSetId: Joi.string().allow(null),
            primaryContract: Joi.string()
              .lowercase()
              .pattern(/^0x[a-fA-F0-9]{40}$/),
            floorAskPrice: Joi.number().unsafe().allow(null),
            topBidValue: Joi.number().unsafe().allow(null),
            topBidMaker: Joi.string()
              .lowercase()
              .pattern(/^0x[a-fA-F0-9]{40}$/)
              .allow(null),
            rank: Joi.object({
              "1day": Joi.number().unsafe().allow(null),
              "7day": Joi.number().unsafe().allow(null),
              "30day": Joi.number().unsafe().allow(null),
              allTime: Joi.number().unsafe().allow(null),
            }),
            volume: Joi.object({
              "1day": Joi.number().unsafe().allow(null),
              "7day": Joi.number().unsafe().allow(null),
              "30day": Joi.number().unsafe().allow(null),
              allTime: Joi.number().unsafe().allow(null),
            }),
            volumeChange: {
              "1day": Joi.number().unsafe().allow(null),
              "7day": Joi.number().unsafe().allow(null),
              "30day": Joi.number().unsafe().allow(null),
            },
            floorSale: {
              "1day": Joi.number().unsafe().allow(null),
              "7day": Joi.number().unsafe().allow(null),
              "30day": Joi.number().unsafe().allow(null),
            },
          }),
          ownership: Joi.object({
            tokenCount: Joi.string(),
            onSaleCount: Joi.string(),
            liquidCount: Joi.string(),
          }),
        })
      ),
    }).label(`getUserCollections${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-user-collections-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const params = request.params as any;
    const query = request.query as any;

    try {
      let baseQuery = `
        SELECT  collections.id,
                collections.slug,
                collections.name,
                (collections.metadata ->> 'imageUrl')::TEXT AS "image",
                (collections.metadata ->> 'bannerImageUrl')::TEXT AS "banner",
                (collections.metadata ->> 'discordUrl')::TEXT AS "discord_url",
                (collections.metadata ->> 'description')::TEXT AS "description",
                (collections.metadata ->> 'externalUrl')::TEXT AS "external_url",
                (collections.metadata ->> 'twitterUsername')::TEXT AS "twitter_username",
                collections.contract,
                collections.token_set_id,
                collections.token_count,
                (
                  SELECT array(
                    SELECT tokens.image FROM tokens
                    WHERE tokens.collection_id = collections.id
                    LIMIT 4
                  )
                ) AS sample_images,
                collections.day1_volume,
                collections.day7_volume,
                collections.day30_volume,
                collections.all_time_volume,
                collections.day1_rank,
                collections.day7_rank,
                collections.day30_rank,
                collections.all_time_rank,
                collections.day1_volume_change,
                collections.day7_volume_change,
                collections.day30_volume_change,
                collections.floor_sell_value,
                collections.day1_floor_sell_value,
                collections.day7_floor_sell_value,
                collections.day30_floor_sell_value,
                SUM(nft_balances.amount) AS owner_token_count,
                SUM(CASE WHEN tokens.floor_sell_value IS NULL THEN 0 ELSE 1 END) AS owner_on_sale_count,
                SUM(CASE WHEN tokens.top_buy_value IS NULL THEN 0 ELSE 1 END) AS owner_liquid_count
        FROM nft_balances
        JOIN tokens ON nft_balances.contract = tokens.contract AND nft_balances.token_id = tokens.token_id
        JOIN collections ON tokens.collection_id = collections.id
      `;

      // Filters
      (params as any).user = toBuffer(params.user);
      const conditions: string[] = [`nft_balances.owner = $/user/`, `nft_balances.amount > 0`];

      if (query.community) {
        conditions.push(`collections.community = $/community/`);
      }
      if (query.collection) {
        conditions.push(`collections.id = $/collection/`);
      }
      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Grouping
      baseQuery += ` GROUP BY collections.id, nft_balances.owner`;

      // Sorting
      baseQuery += ` ORDER BY collections.all_time_volume DESC`;

      // Pagination
      baseQuery += ` OFFSET $/offset/`;
      baseQuery += ` LIMIT $/limit/`;

      let topBidQuery = "";
      if (query.includeTopBid) {
        topBidQuery = `LEFT JOIN LATERAL (
          SELECT
            token_sets.top_buy_value,
            token_sets.top_buy_maker
          FROM token_sets
          WHERE token_sets.id = x.token_set_id
          ORDER BY token_sets.top_buy_value DESC
          LIMIT 1
        ) y ON TRUE`;
      }

      baseQuery = `
        WITH x AS (${baseQuery})
        SELECT *
        FROM x
        ${topBidQuery}
      `;

      const result = await edb.manyOrNone(baseQuery, { ...params, ...query });
      const collections = _.map(result, (r) => {
        const response = {
          collection: {
            id: r.id,
            slug: r.slug,
            name: r.name,
            image: r.image || (r.sample_images?.length ? r.sample_images[0] : null),
            banner: r.banner,
            discordUrl: r.discord_url,
            externalUrl: r.external_url,
            twitterUsername: r.twitter_username,
            description: r.description,
            sampleImages: r.sample_images || [],
            tokenCount: String(r.token_count),
            primaryContract: fromBuffer(r.contract),
            tokenSetId: r.token_set_id,
            floorAskPrice: r.floor_sell_value ? formatEth(r.floor_sell_value) : null,
            rank: {
              "1day": r.day1_rank,
              "7day": r.day7_rank,
              "30day": r.day30_rank,
              allTime: r.all_time_rank,
            },
            volume: {
              "1day": r.day1_volume ? formatEth(r.day1_volume) : null,
              "7day": r.day7_volume ? formatEth(r.day7_volume) : null,
              "30day": r.day30_volume ? formatEth(r.day30_volume) : null,
              allTime: r.all_time_volume ? formatEth(r.all_time_volume) : null,
            },
            volumeChange: {
              "1day": r.day1_volume_change,
              "7day": r.day7_volume_change,
              "30day": r.day30_volume_change,
            },
            floorSale: {
              "1day": r.day1_floor_sell_value ? formatEth(r.day1_floor_sell_value) : null,
              "7day": r.day7_floor_sell_value ? formatEth(r.day7_floor_sell_value) : null,
              "30day": r.day30_floor_sell_value ? formatEth(r.day30_floor_sell_value) : null,
            },
          },
          ownership: {
            tokenCount: String(r.owner_token_count),
            onSaleCount: String(r.owner_on_sale_count),
            liquidCount: String(r.owner_liquid_count),
          },
        };

        if (query.includeTopBid) {
          (response as any).collection.topBidValue = r.top_buy_value
            ? formatEth(r.top_buy_value)
            : null;
          (response as any).collection.topBidMaker = r.top_buy_maker
            ? fromBuffer(r.top_buy_maker)
            : null;
        }

        return response;
      });

      return { collections };
    } catch (error) {
      logger.error(`get-user-collections-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};