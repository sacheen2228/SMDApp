#!/bin/bash
# Start MiniCPM-V service

cd /home/sachin/Desktop/SMDApp/MiniCPM-V

# Check if model is available, if not download
echo "Starting MiniCPM-V service on port 8888..."
echo "Model: openbmb/MiniCPM-V-2_6"
echo ""

# Run with appropriate device
# For CUDA: python minicpm_service.py
# For MPS (Mac): PYTORCH_ENABLE_MPS_FALLBACK=1 python minicpm_service.py
# For CPU: python minicpm_service.py --device cpu

python /home/sachin/Desktop/SMDApp/minicpm_service.py
