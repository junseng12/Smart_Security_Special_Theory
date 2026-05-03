/**
 * SSE Client Registry
 * 사용자 주소별 SSE 연결을 관리하고 이벤트를 브로드캐스트
 */

const { v4: uuidv4 } = require('uuid');

const clients = new Map(); // clientId → { userAddress, res }

function register(userAddress, res) {
  const clientId = uuidv4();
  clients.set(clientId, { userAddress: userAddress.toLowerCase(), res });
  return clientId;
}

function remove(clientId) {
  clients.delete(clientId);
}

/**
 * 특정 사용자 주소로 이벤트 전송
 */
function broadcast(userAddress, payload) {
  const target = userAddress.toLowerCase();
  const data = `data: ${JSON.stringify(payload)}\n\n`;

  for (const [, client] of clients) {
    if (client.userAddress === target) {
      try {
        client.res.write(data);
      } catch (_) {
        // 클라이언트 연결 끊김 — 무시
      }
    }
  }
}

/**
 * 전체 브로드캐스트 (관리자 공지 등)
 */
function broadcastAll(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [, client] of clients) {
    try { client.res.write(data); } catch (_) {}
  }
}

module.exports = { register, remove, broadcast, broadcastAll };
