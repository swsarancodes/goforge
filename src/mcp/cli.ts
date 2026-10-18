#!/usr/bin/env node
import { GoForgeMcpServer } from "./server";

const server = new GoForgeMcpServer();
server.startStdio();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
