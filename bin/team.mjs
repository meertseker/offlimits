#!/usr/bin/env node
import { main } from '../hooks/lib/team/cli.mjs';

process.exit(await main(process.argv.slice(2)));
