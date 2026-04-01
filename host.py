import socket
import json
import threading
import time
import struct
import sys
import os

# =========================================================================
#   CẤU HÌNH TRỰC TIẾP TẠI ĐÂY (KHÔNG CẦN FILE CONFIG)
# =========================================================================
SERVER_HOST = "mbasic7.pikamc.vn"
SERVER_PORT = 25284
CLIENT_ID   = "bedrock-host-1"
LOCAL_HOST  = "169.254.238.23" # IP LAN của bạn
LOCAL_PORT  = 7551            # Port Minecraft đang mở (7551 hoặc 19132)
MY_KEY      = ""               # Để trống để tự sinh key mới
AUTH_TOKEN  = ""
# =========================================================================

class UDP_MSG:
    HANDSHAKE = 0x01
    DATA      = 0x02
    CLOSE     = 0x03
    PING      = 0x04
    PONG      = 0x05

def build_udp_message(msg_type, key, session_id, payload=None):
    if payload is None: payload = b''
    k_bytes = key.encode('utf8')
    s_bytes = session_id.encode('utf8')
    header = struct.pack('>B H', msg_type, len(k_bytes)) + k_bytes + struct.pack('>H', len(s_bytes)) + s_bytes
    return header + payload

def parse_udp_message(data):
    try:
        msg_type = data[0]
        k_len = struct.unpack('>H', data[1:3])[0]
        key = data[3:3+k_len].decode('utf8')
        s_len = struct.unpack('>H', data[3+k_len:5+k_len])[0]
        sid = data[5+k_len:5+k_len+s_len].decode('utf8')
        payload = data[5+k_len+s_len:]
        return {"type": msg_type, "key": key, "id": sid, "payload": payload}
    except: return None

class BedrockAgent:
    def __init__(self):
        self.server_host = SERVER_HOST
        self.server_port = SERVER_PORT
        self.client_id = CLIENT_ID
        self.local_host = LOCAL_HOST
        self.local_port = LOCAL_PORT
        self.my_key = MY_KEY
        self.auth_token = AUTH_TOKEN
        
        self.udp_ready = False
        self.udp_sock = None
        self.sessions = {} # sid -> socket
        self.running = True

    def log(self, tag, msg, color='\033[0m'):
        print(f"{color}[{tag}] {msg}\033[0m")

    def connect_control(self):
        while self.running:
            try:
                self.log("Control", f"Connecting to {self.server_host}:{self.server_port}...", '\033[36m')
                tcp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                tcp_sock.settimeout(10)
                tcp_sock.connect((self.server_host, self.server_port))
                tcp_sock.settimeout(None)
                
                # Register
                reg = {
                    "type": "register",
                    "key": self.my_key,
                    "token": self.auth_token,
                    "client_id": self.client_id,
                    "target": f"{self.local_host}:{self.local_port}",
                    "protocol": "udp"
                }
                tcp_sock.sendall((json.dumps(reg) + "\n").encode('utf8'))
                
                # Read loop
                buf = ""
                while self.running:
                    raw = tcp_sock.recv(4096)
                    if not raw: break
                    buf += raw.decode('utf8', errors='ignore')
                    while "\n" in buf:
                        if "\n" not in buf: break
                        line, buf = buf.split("\n", 1)
                        if line.strip():
                            try:
                                msg = json.loads(line)
                                self.handle_control(msg, tcp_sock)
                            except: pass
                
                tcp_sock.close()
            except Exception as e:
                self.log("Error", f"Control failed: {e}", '\033[31m')
            
            self.udp_ready = False
            time.sleep(3)

    def start(self):
        self.connect_control()

    def handle_control(self, msg, tcp_sock):
        mtype = msg.get('type')
        if mtype == 'registered':
            self.my_key = msg.get('key', self.my_key)
            self.log("OK", f"Registered! Key: {self.my_key[:8]}", '\033[32m')
            threading.Thread(target=self.setup_udp_data, daemon=True).start()
            threading.Thread(target=self.tcp_ping_loop, args=(tcp_sock,), daemon=True).start()
        elif mtype == 'udp_open':
            self.open_udp_session(msg.get('id'))
        elif mtype == 'udp_close':
            self.close_udp_session(msg.get('id'))
        elif mtype == 'ping':
            try: tcp_sock.sendall(json.dumps({"type": "pong"}).encode('utf8') + b"\n")
            except: pass
        elif mtype == 'error':
            self.log("Server Error", msg.get('error'), '\033[31m')

    def tcp_ping_loop(self, sock):
        while self.running:
            try:
                time.sleep(15)
                sock.sendall(json.dumps({"type": "pong"}).encode('utf8') + b"\n")
            except: break

    def setup_udp_data(self):
        self.udp_ready = False
        try:
            self.udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            def handshake():
                while not self.udp_ready and self.running:
                    pkt = build_udp_message(UDP_MSG.HANDSHAKE, self.my_key, "")
                    self.udp_sock.sendto(pkt, (self.server_host, self.server_port))
                    time.sleep(1)
            threading.Thread(target=handshake, daemon=True).start()
            
            while self.running:
                data, addr = self.udp_sock.recvfrom(65535)
                parsed = parse_udp_message(data)
                if not parsed or parsed['key'] != self.my_key: continue
                
                ptype = parsed['type']
                if ptype == UDP_MSG.HANDSHAKE:
                    if not self.udp_ready:
                        self.udp_ready = True
                        self.log("UDP", "Data channel connected!", '\033[32m')
                elif ptype == UDP_MSG.DATA:
                    sid = parsed['id']
                    if sid in self.sessions:
                        self.sessions[sid].sendto(parsed['payload'], (self.local_host, self.local_port))
                elif ptype == UDP_MSG.PING:
                    pong = build_udp_message(UDP_MSG.PONG, self.my_key, parsed['id'], parsed['payload'])
                    self.udp_sock.sendto(pong, (self.server_host, self.server_port))
        except: pass

    def open_udp_session(self, sid):
        if sid in self.sessions: self.close_udp_session(sid)
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(('0.0.0.0', 0))
            self.sessions[sid] = sock
            self.log("Link", f"Player joined. Session: {sid}", '\033[34m')
            def game_to_server():
                while sid in self.sessions and self.running:
                    try:
                        data, addr = sock.recvfrom(65535)
                        if self.udp_ready:
                            pkt = build_udp_message(UDP_MSG.DATA, self.my_key, sid, data)
                            self.udp_sock.sendto(pkt, (self.server_host, self.server_port))
                    except: break
            threading.Thread(target=game_to_server, daemon=True).start()
        except: pass

    def close_udp_session(self, sid):
        if sid in self.sessions:
            try: self.sessions[sid].close()
            except: pass
            del self.sessions[sid]
            self.log("End", f"Player left. Session: {sid}", '\033[31m')

if __name__ == "__main__":
    print(f"\n\033[35m=== BEDROCK TUNNEL AGENT (Python FRP) ===\033[0m")
    print(f"Target: {LOCAL_HOST}:{LOCAL_PORT}")
    print(f"-----------------------------------------\n")
    agent = BedrockAgent()
    try:
        agent.start()
    except KeyboardInterrupt:
        print("\nStopping...")
        agent.running = False
        sys.exit(0)
