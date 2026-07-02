"""
MelodyBox — 网易云音乐播放器（静态服务）
仅负责托管前端文件，音乐数据由 NeteaseCloudMusicApi (localhost:3000) 提供
"""
from flask import Flask, Response, send_from_directory
from flask_cors import CORS
from pathlib import Path
import threading
import logging
import webbrowser

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-XSS-Protection"] = "1; mode=block"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' blob: https:; "
        "connect-src 'self' http://localhost:3000; "
        "font-src 'self' data:;"
    )
    return resp


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


def _serve_static(filename, mimetype):
    path = Path(filename)
    if path.exists():
        return Response(path.read_bytes(), mimetype=mimetype)
    return '', 404


@app.route('/style.css')
def style_css():
    return _serve_static('style.css', 'text/css; charset=utf-8')


@app.route('/app.js')
def app_js():
    return _serve_static('app.js', 'application/javascript; charset=utf-8')


if __name__ == '__main__':
    port = 5000
    threading.Timer(1.5, lambda: webbrowser.open(f'http://localhost:{port}')).start()
    logger.info("=" * 46)
    logger.info("    MelodyBox — http://localhost:" + str(port))
    logger.info("    网易云音乐模式")
    logger.info("    请确保 NeteaseCloudMusicApi 已在 localhost:3000 运行")
    logger.info("=" * 46)
    app.run(host='127.0.0.1', port=port, debug=False)
