const http = require('http');
const https = require('https');
const net = require('net');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const dns = require('dns').promises;

// 配置
let userID = process.env.UUID || '53fa8faf-ba4b-4322-9c69-a3e5b1555049';
const PORT = process.env.SERVER_PORT || process.env.PORT || 7860;

// WebSocket 状态常量
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// 创建HTTP服务器
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // 处理根路径请求
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
      return;
    }
    
    // 处理 UUID 路径请求，返回配置信息
    if (url.pathname === `/${userID}`) {
      const host = req.headers.host;
      const vlessConfig = `vless://${userID}@${host}:443?encryption=none&security=none&type=ws&host=${host}&path=/#${host}`;
      res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end(vlessConfig);
      return;
    }
    
    // 健康检查端点
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'WebSocket Server',
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.toString());
  }
});

// 创建WebSocket服务器
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log('新的WebSocket连接');
  
  // 处理WebSocket消息
  let remoteSocket = null;
  let udpStreamWrite = null;
  let isDns = false;
  let isFirstMessage = true;
  
  ws.on('message', async (data) => {
    try {
      // 如果是DNS请求且已经有UDP流处理器，直接转发数据
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(data);
      }
      
      // 如果已经建立远程连接，直接转发数据
      if (remoteSocket && !isFirstMessage) {
        remoteSocket.write(data);
        return;
      }
      
      if (isFirstMessage) {
        isFirstMessage = false;
        
        
        const result = parseVLESSHeader(data, userID);
        if (result.hasError) {
          throw new Error(result.message);
        }

        // 构造响应头
        const vlessRespHeader = Buffer.from([result.vlessVersion[0], 0]);
        const rawClientData = data.slice(result.rawDataIndex);
        
        // 检查是否为UDP请求
        if (result.isUDP) {
          // 仅支持DNS请求（端口53）
          if (result.portRemote === 53) {
            isDns = true;
            const { write } = await handleUDPOutBound(ws, vlessRespHeader);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          } else {
            throw new Error('UDP代理仅支持DNS(端口53)');
          }
        }

        // 建立 TCP 连接
        console.log(`连接到: ${result.addressRemote}:${result.portRemote}`);
        
        remoteSocket = net.createConnection({
          host: result.addressRemote,
          port: result.portRemote
        });

        remoteSocket.on('connect', () => {
          console.log(`成功连接到 ${result.addressRemote}:${result.portRemote}`);
          // 发送原始客户端数据
          remoteSocket.write(rawClientData);
        });

        remoteSocket.on('data', (data) => {
          if (ws.readyState === WS_READY_STATE_OPEN) {
            // 第一次发送数据时包含VLESS响应头
            if (!remoteSocket.headerSent) {
              const combined = Buffer.concat([vlessRespHeader, data]);
              ws.send(combined);
              remoteSocket.headerSent = true;
            } else {
              ws.send(data);
            }
          }
        });

        remoteSocket.on('close', () => {
          console.log('远程连接关闭');
          if (ws.readyState === WS_READY_STATE_OPEN) {
            ws.close(1000, '远程连接关闭');
          }
        });

        remoteSocket.on('error', (err) => {
          console.error('远程连接错误:', err.message);
          if (ws.readyState === WS_READY_STATE_OPEN) {
            ws.close(1011, `连接错误: ${err.message}`);
          }
        });
      }
    } catch (err) {
      console.error('处理消息错误:', err.message);
      if (remoteSocket) {
        remoteSocket.destroy();
      }
      if (ws.readyState === WS_READY_STATE_OPEN) {
        ws.close(1011, err.message);
      }
    }
  });

  ws.on('close', () => {
    console.log('WebSocket连接关闭');
    if (remoteSocket) {
      remoteSocket.destroy();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket错误:', err.message);
    if (remoteSocket) {
      remoteSocket.destroy();
    }
  });
});


function parseVLESSHeader(buffer, userID) {
  // 最小头部长度：1(版本) + 16(UUID) + 1(附加信息长度) + 1(命令) + 2(端口) + 1(地址类型) + 1(地址长度) + 1(最小地址)
  if (buffer.length < 24) {
    return { hasError: true, message: '无效的头部长度' };
  }
  
  const version = buffer.slice(0, 1);
  
  // 验证 UUID
  const uuid = formatUUID(buffer.slice(1, 17));
  if (uuid !== userID) {
    return { hasError: true, message: '无效的用户' };
  }
  
  const optionsLength = buffer.readUInt8(17);
  const command = buffer.readUInt8(18 + optionsLength);
  
  // 支持 TCP 和 UDP 命令
  let isUDP = false;
  if (command === 1) {
    // TCP
  } else if (command === 2) {
    // UDP
    isUDP = true;
  } else {
    return { hasError: true, message: '不支持的命令，仅支持TCP(01)和UDP(02)' };
  }
  
  let offset = 19 + optionsLength;
  const port = buffer.readUInt16BE(offset);
  offset += 2;
  
  // 解析地址
  const addressType = buffer.readUInt8(offset++);
  let address = '';
  
  switch (addressType) {
    case 1: // IPv4
      address = Array.from(buffer.slice(offset, offset + 4)).join('.');
      offset += 4;
      break;
      
    case 2: // 域名
      const domainLength = buffer.readUInt8(offset++);
      address = buffer.slice(offset, offset + domainLength).toString('utf8');
      offset += domainLength;
      break;
      
    case 3: // IPv6
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(buffer.readUInt16BE(offset).toString(16).padStart(4, '0'));
        offset += 2;
      }
      address = ipv6.join(':').replace(/(^|:)0+(\w)/g, '$1$2');
      break;
      
    default:
      return { hasError: true, message: '不支持的地址类型' };
  }
  
  return {
    hasError: false,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: offset,
    vlessVersion: version,
    isUDP
  };
}

// 格式化 UUID
function formatUUID(bytes) {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// 处理UDP DNS请求
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
  let isVlessHeaderSent = false;
  
  const processUDPData = async (chunk) => {
    // 解析UDP数据包
    let index = 0;
    while (index < chunk.length) {
      if (index + 2 > chunk.length) break;
      
      const udpPacketLength = chunk.readUInt16BE(index);
      if (index + 2 + udpPacketLength > chunk.length) break;
      
      const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
      index = index + 2 + udpPacketLength;
      
      try {
        // 使用Cloudflare的DNS over HTTPS服务
        const response = await fetch('https://1.1.1.1/dns-query', {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
          },
          body: udpData,
        });
        
        const dnsQueryResult = await response.arrayBuffer();
        const resultBuffer = Buffer.from(dnsQueryResult);
        const udpSize = resultBuffer.length;
        const udpSizeBuffer = Buffer.allocUnsafe(2);
        udpSizeBuffer.writeUInt16BE(udpSize, 0);
        
        if (webSocket.readyState === WS_READY_STATE_OPEN) {
          console.log(`DNS查询成功，DNS消息长度为 ${udpSize}`);
          if (isVlessHeaderSent) {
            webSocket.send(Buffer.concat([udpSizeBuffer, resultBuffer]));
          } else {
            webSocket.send(Buffer.concat([vlessResponseHeader, udpSizeBuffer, resultBuffer]));
            isVlessHeaderSent = true;
          }
        }
      } catch (error) {
        console.error('DNS查询失败:', error.message);
      }
    }
  };

  return {
    write: processUDPData
  };
}

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`UUID: ${userID}`);
  console.log(`健康检查: /health`);
  if (userID) {
    console.log(`订阅链接: /${userID}`);
  }
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
