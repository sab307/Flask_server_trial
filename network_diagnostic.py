#!/usr/bin/env python3
"""
Network Diagnostics Tool for WebRTC Streaming System
Tests connectivity between sender and receiver across networks
"""

import argparse
import socket
import subprocess
import sys
import urllib.request
import urllib.error
import json
from urllib.parse import urlparse


def print_section(title):
    """Print a formatted section header"""
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def test_dns_resolution(hostname):
    """Test if hostname resolves to an IP address"""
    print(f"\n🔍 Testing DNS resolution for: {hostname}")
    try:
        ip = socket.gethostbyname(hostname)
        print(f"   ✅ Resolved to: {ip}")
        return True, ip
    except socket.gaierror as e:
        print(f"   ❌ Failed to resolve: {e}")
        return False, None


def test_ping(host):
    """Test if host is reachable via ping"""
    print(f"\n🏓 Testing ping to: {host}")
    try:
        # Try ping with 3 packets, 2 second timeout
        result = subprocess.run(
            ['ping', '-c', '3', '-W', '2', host],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            # Extract average time from ping output
            for line in result.stdout.split('\n'):
                if 'avg' in line or 'time' in line:
                    print(f"   ✅ Host is reachable")
                    print(f"   {line.strip()}")
            return True
        else:
            print(f"   ❌ Ping failed (host may be blocking ICMP)")
            return False
    except subprocess.TimeoutExpired:
        print(f"   ❌ Ping timeout")
        return False
    except FileNotFoundError:
        print(f"   ⚠️  Ping command not found, skipping")
        return None


def test_port_open(host, port):
    """Test if a specific port is open"""
    print(f"\n🔌 Testing port {port} on {host}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    
    try:
        result = sock.connect_ex((host, port))
        if result == 0:
            print(f"   ✅ Port {port} is OPEN")
            return True
        else:
            print(f"   ❌ Port {port} is CLOSED or FILTERED")
            return False
    except socket.gaierror:
        print(f"   ❌ Could not resolve hostname")
        return False
    except Exception as e:
        print(f"   ❌ Error testing port: {e}")
        return False
    finally:
        sock.close()


def test_http_endpoint(url, endpoint="/health"):
    """Test if HTTP endpoint is accessible"""
    full_url = url.rstrip('/') + endpoint
    print(f"\n🌐 Testing HTTP endpoint: {full_url}")
    
    try:
        req = urllib.request.Request(full_url, method='GET')
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                body = response.read().decode('utf-8')
                print(f"   ✅ Endpoint is accessible (HTTP {response.status})")
                try:
                    data = json.loads(body)
                    print(f"   📊 Response: {json.dumps(data, indent=6)}")
                except:
                    print(f"   📄 Response: {body[:200]}")
                return True
            else:
                print(f"   ⚠️  Got HTTP {response.status}")
                return False
    except urllib.error.HTTPError as e:
        print(f"   ❌ HTTP Error {e.code}: {e.reason}")
        return False
    except urllib.error.URLError as e:
        print(f"   ❌ Connection failed: {e.reason}")
        return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False


def get_local_ip():
    """Get local IP address"""
    try:
        # Create a socket to determine the local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except:
        return "Unknown"


def test_firewall_ports():
    """Check if firewall might be blocking ports"""
    print(f"\n🛡️  Checking firewall (Linux)")
    try:
        # Check if ufw is active
        result = subprocess.run(
            ['sudo', 'ufw', 'status'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if 'Status: active' in result.stdout:
            print("   ⚠️  UFW firewall is ACTIVE")
            print("   You may need to allow ports:")
            print("   sudo ufw allow 8080/tcp")
            print("   sudo ufw allow 8081/tcp")
        else:
            print("   ℹ️  UFW firewall is inactive or not installed")
            
    except (subprocess.TimeoutExpired, FileNotFoundError):
        print("   ℹ️  Could not check UFW status")


def main():
    parser = argparse.ArgumentParser(
        description="Network diagnostics for WebRTC streaming system"
    )
    parser.add_argument(
        "--sender-url",
        required=True,
        help="URL of the sender (e.g., http://141.44.157.6:8085)"
    )
    parser.add_argument(
        "--skip-ping",
        action="store_true",
        help="Skip ping test (useful if ICMP is blocked)"
    )
    
    args = parser.parse_args()
    
    # Parse sender URL
    parsed = urlparse(args.sender_url)
    sender_host = parsed.hostname
    sender_port = parsed.port or 8080
    
    print_section("WebRTC Network Diagnostics Tool")
    
    print(f"\n📋 Configuration:")
    print(f"   Sender URL: {args.sender_url}")
    print(f"   Sender Host: {sender_host}")
    print(f"   Sender Port: {sender_port}")
    print(f"   Your IP: {get_local_ip()}")
    
    # Run tests
    print_section("Running Connectivity Tests")
    
    results = {}
    
    # Test 1: DNS Resolution
    results['dns'], resolved_ip = test_dns_resolution(sender_host)
    
    # Test 2: Ping (optional)
    if not args.skip_ping:
        results['ping'] = test_ping(sender_host)
    else:
        print("\n🏓 Ping test skipped")
        results['ping'] = None
    
    # Test 3: Port connectivity
    results['port'] = test_port_open(sender_host, sender_port)
    
    # Test 4: HTTP endpoint
    results['http'] = test_http_endpoint(args.sender_url)
    
    # Test 5: Firewall check
    test_firewall_ports()
    
    # Summary
    print_section("Summary")
    
    all_passed = all(v for v in results.values() if v is not None)
    
    if all_passed:
        print("\n✅ All tests PASSED! Network connectivity looks good.")
        print("\nYour WebRTC system should work across these networks.")
    else:
        print("\n❌ Some tests FAILED. Review the issues above.")
        print("\n🔧 Troubleshooting steps:")
        
        if not results['dns']:
            print("\n   1. DNS Resolution Failed:")
            print("      - Check if the hostname is correct")
            print("      - Try using IP address instead")
            print(f"      - Example: http://{resolved_ip or 'IP_ADDRESS'}:{sender_port}")
        
        if results['ping'] is False:
            print("\n   2. Ping Failed:")
            print("      - Host may be blocking ICMP (ping)")
            print("      - This is common and may not be a problem")
            print("      - Continue testing other connections")
        
        if not results['port']:
            print(f"\n   3. Port {sender_port} is Not Reachable:")
            print("      - Sender firewall may be blocking the port")
            print("      - Sender commands to allow port:")
            print(f"        sudo ufw allow {sender_port}/tcp")
            print(f"        sudo firewall-cmd --add-port={sender_port}/tcp --permanent")
            print("      - Network firewall/router may be blocking")
            print("      - Check if sender is actually running")
        
        if not results['http']:
            print("\n   4. HTTP Endpoint Not Accessible:")
            print("      - Make sure sender is running:")
            print(f"        python3 sender.py --host 0.0.0.0 --port {sender_port}")
            print("      - Check sender is binding to 0.0.0.0 (not 127.0.0.1)")
            print("      - Verify firewall allows the connection")
            print("      - Check network routing/NAT configuration")
    
    print("\n" + "=" * 70)
    print("\n💡 Common Solutions:\n")
    print("   • Sender MUST bind to 0.0.0.0 (not localhost)")
    print("   • Both sender and receiver firewalls must allow ports")
    print("   • Use IP addresses instead of hostnames if DNS fails")
    print("   • Ensure no NAT/router blocking between networks")
    print("   • For VPN: use VPN IP addresses (e.g., Tailscale)")
    print("\n" + "=" * 70 + "\n")


if __name__ == "__main__":
    main()