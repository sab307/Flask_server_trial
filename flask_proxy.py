#!/usr/bin/env python3

try:
    from flask import Flask, request, Response
    import requests
except ImportError:
    print("Flask not installed. Install with: pip3 install flask requests")
    exit(1)

# Configuration
BACKEND = "http://127.0.0.1:8081"
PORT = 8080

app = Flask(__name__)

@app.route('/', defaults={'path': ''}, methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy(path):
    """Forward all requests to backend"""
    url = f"{BACKEND}/{path}"
    
    # Forward the request
    resp = requests.request(
        method=request.method,
        url=url,
        headers={k:v for k,v in request.headers if k != 'Host'},
        data=request.get_data(),
        cookies=request.cookies,
        allow_redirects=False
    )
    
    # Return the response
    return Response(resp.content, resp.status_code, resp.headers.items())

if __name__ == '__main__':
    print(f"Flask Proxy Server")
    print(f"Listening on: http://0.0.0.0:{PORT}")
    print(f"Backend: {BACKEND}")
    print("-" * 50)
    app.run(host='0.0.0.0', port=PORT, debug=False)