/* eslint-disable import/no-extraneous-dependencies */
import { Miniflare } from "miniflare";
import { CloudflareD1Saver } from "../src/index.js";

import type { CheckpointerTestInitializer } from "@langchain/langgraph-checkpoint-validation";

export const initializer: CheckpointerTestInitializer<CloudflareD1Saver> = {
  checkpointerName: "langgraph-checkpoint-cloudflare-d1",

  async beforeAll() {
  },

  beforeAllTimeout: 300_000, // five minutes, to pull docker container

  async afterAll() {
  },

  async createCheckpointer() {
    const mf = new Miniflare({
      modules: true,
      script: `
      export default {
        async fetch(request, env, ctx) {
          return new Response("Hello Miniflare!");
        }
      }`,
      d1Databases: {
        DB: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
    });

    const db = await mf.getD1Database("DB");

    const checkpointer: CloudflareD1Saver = new CloudflareD1Saver(db);
    // Store miniflare reference for cleanup
    (checkpointer as any)._mf = mf;
    return checkpointer;
  },

  async destroyCheckpointer(checkpointer: CloudflareD1Saver) {
    // Clean up miniflare instance
    const mf = (checkpointer as any)._mf;
    if (mf) {
      await mf.dispose();
    }
  },
};

export default initializer;
