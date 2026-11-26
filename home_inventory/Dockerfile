ARG BUILD_FROM
FROM $BUILD_FROM

# Python + Flask from Alpine packages (no pip build step needed on the Pi)
RUN apk add --no-cache python3 py3-flask py3-waitress py3-openpyxl

COPY app /app
WORKDIR /app

ENV DATA_DIR=/data PORT=8099
CMD ["python3", "/app/server.py"]
