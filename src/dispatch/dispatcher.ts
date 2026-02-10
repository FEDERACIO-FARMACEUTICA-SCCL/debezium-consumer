import { PayloadType, AnyPayload } from "../types/payloads";
import { logger } from "../logger";

export interface PayloadDispatcher {
  dispatch(type: PayloadType, codigo: string, payload: AnyPayload): Promise<void>;
}

export class LogDispatcher implements PayloadDispatcher {
  async dispatch(type: PayloadType, _codigo: string, _payload: AnyPayload): Promise<void> {
    logger.debug({ tag: "Dispatcher", type }, "Payload dispatched (log only)");
  }
}
