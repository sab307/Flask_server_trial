from flask import Flask, request, jsonify
from datetime import datetime

app = Flask(__name__)

# In-memory storage for data
data_store = []

@app.route('/')
def home():
    return '''
    <h1>Simple Python Web Server</h1>
    <p>Available endpoints:</p>
    <ul>
        <li>GET / - This page</li>
        <li>GET /data - Get all stored data</li>
        <li>POST /data - Send data (JSON body: {"message": "your message"})</li>
        <li>GET /health - Health check</li>
    </ul>
    '''

@app.route('/health')
def health():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat()
    })

@app.route('/data', methods=['GET'])
def get_data():
    return jsonify({
        'count': len(data_store),
        'data': data_store
    })

@app.route('/data', methods=['POST'])
def post_data():
    try:
        content = request.get_json()
        
        if not content:
            return jsonify({'error': 'No JSON data provided'}), 400
        
        # Add timestamp to the data
        entry = {
            'timestamp': datetime.now().isoformat(),
            'data': content
        }
        
        data_store.append(entry)
        
        return jsonify({
            'message': 'Data received successfully',
            'entry': entry
        }), 201
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("Starting server on http://0.0.0.0:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)