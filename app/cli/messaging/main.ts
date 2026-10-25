import { createInterface } from 'node:readline';
import { MessageGateway, type GatewayConfig, type SendParams } from './adapters';
import type { MessagePlatformId } from '../../src/lib/messagePlatforms';

const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const gateway = new MessageGateway(output);
const input = createInterface({ input: process.stdin });
// Requests run concurrently so a pending QR status cannot block replies or disconnects.
input.on('line', (line) => {
  let request: { requestId: string; id: MessagePlatformId; method: string; params: Record<string, unknown> };
  try { request = JSON.parse(line); } catch { return; }
  void (async () => {
    try {
      let data: unknown;
      switch (request.method) {
        case 'connect': data = await gateway.connect(request.params as unknown as GatewayConfig); break;
        case 'disconnect': data = await gateway.disconnect(request.id); break;
        case 'qr': data = await gateway.qr(); break;
        case 'checkQr': data = await gateway.checkQr(String(request.params.qrcode ?? '')); break;
        case 'send': data = await gateway.send(request.id, request.params as unknown as SendParams); break;
        default: throw new Error('不支持的消息操作。');
      }
      output({ requestId: request.requestId, data: data ?? null });
    } catch (error) { output({ requestId: request.requestId, error: (error as Error).message }); }
  })();
});
input.on('close', () => { void gateway.close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void gateway.close().finally(() => process.exit(0)); });
