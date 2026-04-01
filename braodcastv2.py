#!/usr/bin/env python3
import hashlib
import os
import select
import socket
import time
import random
import hmac
import io
from collections import namedtuple
import struct
import re

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# =========================================================
# MAP PROTOCOL → MINECRAFT VERSION
# =========================================================
PROTOCOL_TO_MC_VERSION = {
    582: "1.21.130", 581: "1.21.120", 580: "1.21.110", 579: "1.21.100",
    589: "1.20.81", 588: "1.20.80", 567: "1.20.50", 560: "1.20.40",
    554: "1.20.30", 545: "1.20.10",
}

def protocol_to_mc_version(proto: int) -> str:
    return PROTOCOL_TO_MC_VERSION.get(proto, f"Unknown ({proto})")

# --- KHỞI TẠO HỆ THỐNG ---
nethernet_key = hashlib.sha256(struct.pack('<Q', 0xDEADBEEF)).digest()
guid = random.randrange(0, 0x7FFFFFFFFFFFFFFF)

# --- HELPER FUNCTIONS ---
to_le = lambda n, c=8: bytes([(n >> (8 * i)) & 0xFF for i in range(c)])
from_le = lambda b: sum([v << (8 * i) for i, v in enumerate(b)])

def encrypt(data: bytes) -> bytes:
    cipher = Cipher(algorithms.AES(nethernet_key), modes.ECB())
    pad = (16 - len(data) % 16) or 16
    return cipher.encryptor().update(data + bytes([pad] * pad))

def decrypt(data: bytes) -> bytes:
    cipher = Cipher(algorithms.AES(nethernet_key), modes.ECB())
    d = cipher.decryptor().update(data)
    return d[:-d[-1]]

def checksum(data: bytes) -> bytes:
    return hmac.digest(nethernet_key, data, 'sha256')

# --- PACKETS & DATA ---
DiscoveryRequestPacket = namedtuple('DiscoveryRequestPacket', 'id')
DiscoveryResponsePacket = namedtuple('DiscoveryResponsePacket', 
    ['id', 'version', 'server_name', 'level_name', 'game_type', 'player_count', 'max_player_count', 'is_editor_world', 'transport_layer'])

def read_string(buf, lenbytes=1) -> bytes:
    ln = from_le(buf.read(lenbytes))
    return buf.read(ln)

def read_len_prefixed(dec: io.BytesIO) -> bytes:
    len_raw = dec.read(4)
    if len(len_raw) < 4: return b''
    le, be = from_le(len_raw), int.from_bytes(len_raw, 'big')
    remain = len(dec.getbuffer()) - dec.tell()
    ln = le if 0 <= le <= remain else be if 0 <= be <= remain else 0
    return dec.read(ln)

# --- ENCODE / DECODE ---
def nethernet_encode(packet):
    p = io.BytesIO()
    ptype = 0 if isinstance(packet, DiscoveryRequestPacket) else 1
    p.write(to_le(ptype, 2))
    p.write(to_le(packet.id, 8))
    p.write(to_le(0, 8))
    raw = to_le(p.tell() + 2, 2) + p.getvalue()
    return checksum(raw) + encrypt(raw)

def nethernet_decode(packet):
    try:
        raw = io.BytesIO(packet)
        raw.read(32) # checksum
        dec = io.BytesIO(decrypt(raw.read()))
        dec.read(2) # length
        ptype, sid = from_le(dec.read(2)), from_le(dec.read(8))
        dec.read(8) # padding

        if ptype == 0: return DiscoveryRequestPacket(sid)
        raw_inner = read_len_prefixed(dec)
        if not raw_inner: return None
        inner = bytes.fromhex(raw_inner.decode('ascii')) if re.fullmatch(rb'[0-9a-fA-F]+', raw_inner) else raw_inner
        
        dat = io.BytesIO(inner)
        version = from_le(dat.read(1))
        server_name = read_string(dat).decode('utf8', errors='ignore')
        level_name = read_string(dat).decode('utf8', errors='ignore')
        
        # --- FIX: SỬA LẠI ĐỘ DÀI VÀ THỨ TỰ BYTE ---
        # Trong NetherNet, các trường này thường là 2-byte (Short) thay vì 4-byte
        # Và nằm ngay sau chuỗi Level Name
        # Đọc 2 byte
        game_type = from_le(dat.read(1))      
        player_count = from_le(dat.read(4))   # Đọc 2 byte
        max_player_count = from_le(dat.read(2)) # Đọc 2 byte
        
        # Đọc các phần còn lại
        is_editor = bool(from_le(dat.read(1)))
        transport = from_le(dat.read(4))

        return DiscoveryResponsePacket(
            sid, version, server_name, level_name, 
            game_type, player_count, max_player_count, 
            is_editor, transport
        )
    except: return None

# --- CORE LOOP ---
def run_query():
    broadcast_ip = '127.0.0.1'
    print(f'--- ĐANG KHÔI PHỤC KHẢ NĂNG QUÉT LAN ({broadcast_ip}) ---')
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(('', 0)) 

    def ping():
        sock.sendto(nethernet_encode(DiscoveryRequestPacket(guid)), (broadcast_ip, 7551))

    last_ping = 0
    while True:
        now = time.monotonic()
        if now - last_ping >= 2:
            ping()
            last_ping = now

        read, _, _ = select.select([sock], [], [], 0.5)
        for r in read:
            data, peer = r.recvfrom(4096)
            d = nethernet_decode(data)
            if d and d.id != guid:
                print("\n" + "=" * 45)
                print(f"TÌM THẤY SERVER: {peer[0]}")
                print(f" > Tên Server     : {d.server_name}")
                print(f" > Thế giới       : {d.level_name}")
                print(f" > Người chơi     : {d.player_count}/{d.max_player_count}")
                print(f" > Session ID     : {d.id}")
                print("=" * 45)

if __name__ == '__main__':
    try:
        run_query()
    except KeyboardInterrupt:
        print('\nĐã dừng.')