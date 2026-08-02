#!/usr/bin/env node
import { runHeadlessCli } from './headless-cli.js'

void runHeadlessCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[harness] ${message}`)
  process.exitCode = 1
})
