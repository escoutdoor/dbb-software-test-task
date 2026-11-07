import json
import os

import psycopg
from flask import Flask, jsonify

app = Flask(__name__)


def connect_to_database() -> psycopg.Connection:
    # DB_SECRET holds the RDS secret JSON injected by ECS from Secrets Manager.
    secret = json.loads(os.environ["DB_SECRET"])
    return psycopg.connect(
        host=secret["host"],
        port=secret["port"],
        dbname=secret["dbname"],
        user=secret["username"],
        password=secret["password"],
        connect_timeout=3,
    )


@app.get("/health")
def health():
    return jsonify(status="healthy")


@app.get("/db-test")
def db_test():
    try:
        with connect_to_database() as connection:
            connection.execute("SELECT 1")
    except (psycopg.Error, KeyError, ValueError):
        app.logger.exception("database check failed")
        return jsonify(db="unreachable"), 503
    return jsonify(db="connected")
