# ---- data prep image: docker compose run --rm prep --modis ... --viirs ...
FROM python:3.12-slim AS prep
WORKDIR /app/data_prep
COPY data_prep/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY data_prep/*.py ./
ENTRYPOINT ["python", "fire_harmonize.py"]

# ---- frontend build
FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ---- app: FastAPI serves the API and the built frontend (default target)
FROM python:3.12-slim AS app
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/__init__.py backend/main.py backend/admin.py backend/alerts.py backend/
COPY data_prep/fire_harmonize.py data_prep/
COPY --from=web /app/frontend/dist frontend/dist
ENV APP_DATA=/app/backend/app_data PORT=8000
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/meta')"
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}"]
