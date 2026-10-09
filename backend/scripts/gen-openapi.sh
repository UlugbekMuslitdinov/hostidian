#!/bin/sh
# Runs oapi-codegen against ../api/openapi.yaml.
set -eu
cd "$(dirname "$0")/.."
go tool oapi-codegen -config oapi-codegen.yaml ../api/openapi.yaml
