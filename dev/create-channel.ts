#!/usr/bin/env bun
import { createChannel } from "../packages/cli/src/commands/create-channel.ts";

createChannel(process.argv.slice(2));
