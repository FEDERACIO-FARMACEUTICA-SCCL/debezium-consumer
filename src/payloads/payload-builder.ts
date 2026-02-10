import { PayloadType, AnyPayload } from "../types/payloads";

export interface PayloadBuilder<T extends AnyPayload = AnyPayload> {
  readonly type: PayloadType;
  build(codigo: string): T | null;
}

export class PayloadRegistry {
  private builders = new Map<PayloadType, PayloadBuilder>();

  register(builder: PayloadBuilder): void {
    this.builders.set(builder.type, builder);
  }

  get(type: PayloadType): PayloadBuilder | undefined {
    return this.builders.get(type);
  }

  buildAll(
    codigo: string,
    types: Set<PayloadType>
  ): Map<PayloadType, AnyPayload> {
    const results = new Map<PayloadType, AnyPayload>();
    for (const type of types) {
      const builder = this.builders.get(type);
      if (!builder) continue;
      const payload = builder.build(codigo);
      if (payload) results.set(type, payload);
    }
    return results;
  }
}
