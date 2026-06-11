#!/usr/bin/env node
import { main } from "../dist/onboard.js";

await main(process.argv.slice(2));
