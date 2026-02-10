import pino, { Logger } from "pino";

export let logger: Logger = pino({
  level: "info",
  base: { service: "informix-consumer" },
});

export function initLogger(level: string): void {
  logger = pino({ level, base: { service: "informix-consumer" } });
}
