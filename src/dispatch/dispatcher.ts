import { PayloadType, AnyPayload } from "../types/payloads";
import { logger } from "../logger";
import { ApiClient } from "./http-client";

export interface PayloadDispatcher {
  dispatch(type: PayloadType, codigo: string, payload: AnyPayload): Promise<void>;
}

export class LogDispatcher implements PayloadDispatcher {
  async dispatch(type: PayloadType, _codigo: string, _payload: AnyPayload): Promise<void> {
    logger.debug({ tag: "Dispatcher", type }, "Payload dispatched (log only)");
  }
}

const ENDPOINTS: Record<PayloadType, string> = {
  supplier: "/ingest-api/suppliers",
  contact: "/ingest-api/suppliers-contacts",
};

export class HttpDispatcher implements PayloadDispatcher {
  constructor(private client: ApiClient) {}

  async dispatch(type: PayloadType, _codigo: string, payload: AnyPayload): Promise<void> {
    const path = ENDPOINTS[type];
    if (!path) return;
    await this.client.request("PUT", path, payload);
  }
}
