SHELL := /bin/sh

FRONTEND_REPO := git@github.com:aeroserg/mos-sport.git
BACKEND_HOST := root@51.250.100.128
BACKEND_PORT := 4003
BACKEND_KEY := $(HOME)/.ssh/id_ed25519
FRONTEND_LOCAL_DIR := frontend
BACKEND_REMOTE_DIR := /home/admin/mos-sport-backend
BACKEND_LOCAL_DIR := backend
FRONTEND_API_URL ?= https://mos-sport.explaingpt.ru/api

.PHONY: install install-frontend install-backend build-frontend deploy-frontend deploy-backend deploy

install: install-frontend install-backend

install-frontend:
	cd $(FRONTEND_LOCAL_DIR) && npm install

install-backend:
	cd $(BACKEND_LOCAL_DIR) && npm install

build-frontend:
	cd $(FRONTEND_LOCAL_DIR) && VITE_API_BASE_URL=$(FRONTEND_API_URL) npm run build:gh-pages

deploy-frontend:
	cd $(FRONTEND_LOCAL_DIR) && VITE_API_BASE_URL=$(FRONTEND_API_URL) npm run deploy

deploy-backend:
	ssh -i $(BACKEND_KEY) $(BACKEND_HOST) "mkdir -p $(BACKEND_REMOTE_DIR)/src $(BACKEND_REMOTE_DIR)/data"
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/package.json $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/package.json
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/Dockerfile $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/Dockerfile
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/docker-compose.yml $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/docker-compose.yml
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/tsconfig.json $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/tsconfig.json
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/eslint.config.mjs $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/eslint.config.mjs
	scp -r -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/src/* $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/src/
	scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/.env $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/.env
	if [ -f $(BACKEND_LOCAL_DIR)/.env ]; then scp -i $(BACKEND_KEY) $(BACKEND_LOCAL_DIR)/.env $(BACKEND_HOST):$(BACKEND_REMOTE_DIR)/.env; fi
	ssh -i $(BACKEND_KEY) $(BACKEND_HOST) "cd $(BACKEND_REMOTE_DIR) && docker compose up -d --build"

deploy: deploy-frontend deploy-backend
