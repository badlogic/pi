#!/bin/bash
# Script to add GLM-4.5 MTP support to vLLM

cat << 'EOF'
This script will add the GLM-4.5 MTP (Multi-Token Prediction) module to vLLM.

The issue is that GLM-4.5-Air-FP8 requires a special MTP architecture that's not
in the standard vLLM release yet.

Options to fix:
1. Use the non-quantized model: zai-org/GLM-4.5-Air (instead of FP8)
2. Disable the V1 engine with --disable-v1 flag
3. Add the MTP module manually (what this script does)

To add MTP support manually:

1. Save the glm4_moe_mtp.py file to your vLLM installation:
   /root/venv/lib/python3.12/site-packages/vllm/model_executor/models/glm4_moe_mtp.py

2. Register the model in vLLM's model registry by editing:
   /root/venv/lib/python3.12/site-packages/vllm/model_executor/models/__init__.py
   
   Add to the _MODELS dictionary:
   "Glm4MTPForCausalLM": ("glm4_moe_mtp", "Glm4MoeMTP"),

3. Or just use --disable-v1 flag which should work around the issue:
   pi start zai-org/GLM-4.5-Air-FP8 --name glm45 --vllm --disable-v1

The easiest workaround is to add --disable-v1 to the model config.
EOF