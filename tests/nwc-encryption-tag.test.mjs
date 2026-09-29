import assert from "node:assert/strict";
import { test } from "node:test";
import { NWC, RelayPool, getPublicKey } from "nostr-core";

const secret = `0${"0".repeat(62)}1`;
const secretBytes = Uint8Array.from(Buffer.from(secret, "hex"));
const walletPubkey = getPublicKey(secretBytes);
const connectionUrl = `nostr+walletconnect://${walletPubkey}?relay=ws%3A%2F%2Frelay.invalid&secret=${secret}`;

async function captureFirstRequest(infoEncryption) {
  const originals = {
    ensureRelay: RelayPool.prototype.ensureRelay,
    querySync: RelayPool.prototype.querySync,
    subscribe: RelayPool.prototype.subscribe,
    publish: RelayPool.prototype.publish,
  };
  let publishedEvent;
  RelayPool.prototype.ensureRelay = async () => undefined;
  RelayPool.prototype.querySync = async () => [
    { tags: [["encryption", infoEncryption]] },
  ];
  RelayPool.prototype.subscribe = () => ({ close() {} });
  RelayPool.prototype.publish = async (_relays, event) => {
    publishedEvent = event;
    return [];
  };

  const client = new NWC(connectionUrl);
  try {
    await client.connect();
    await assert.rejects(client.getInfo());
    assert.ok(publishedEvent, "NWC request event should be generated before publish failure");
    return publishedEvent;
  } finally {
    client.close();
    RelayPool.prototype.ensureRelay = originals.ensureRelay;
    RelayPool.prototype.querySync = originals.querySync;
    RelayPool.prototype.subscribe = originals.subscribe;
    RelayPool.prototype.publish = originals.publish;
  }
}

test("NIP-44 NWC requests include the required nip44_v2 encryption tag", async () => {
  const event = await captureFirstRequest("nip44_v2 nip04");
  assert.ok(
    event.tags.some(([name, value]) => name === "encryption" && value === "nip44_v2"),
  );
});

test("NIP-04 NWC requests retain the legacy untagged behavior", async () => {
  const event = await captureFirstRequest("nip04");
  assert.deepEqual(event.tags, [["p", walletPubkey]]);
});
