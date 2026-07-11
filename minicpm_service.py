#!/usr/bin/env python3
"""
SmolVLM Image Analysis API Service
Uses Ollama moondream vision model running locally.
"""

import os
import base64
import io
import uvicorn
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from PIL import Image
import requests

app = FastAPI(title="Vision Analysis API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = "qwen2.5:1.5b"

class AnalysisResponse(BaseModel):
    success: bool
    result: Optional[str] = None
    error: Optional[str] = None


def analyze_with_ollama(image_bytes: bytes, prompt: str) -> str:
    """Send image to Ollama moondream for analysis."""
    import base64 as b64
    img_b64 = b64.b64encode(image_bytes).decode("utf-8")

    resp = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={
            "model": MODEL,
            "prompt": prompt,
            "images": [img_b64],
            "stream": False,
            "options": {
                "temperature": 0.7,
                "num_predict": 1024,
            }
        },
        timeout=120
    )

    if resp.status_code == 200:
        data = resp.json()
        return data.get("response", "")
    else:
        raise Exception(f"Ollama error {resp.status_code}: {resp.text[:500]}")


@app.get("/health")
async def health_check():
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        models = [m["name"] for m in resp.json().get("models", [])]
        return {"status": "healthy", "model": MODEL, "backend": "ollama", "available_models": models}
    except Exception as e:
        return {"status": "degraded", "error": str(e)}


@app.post("/analyze")
async def analyze_image(
    file: UploadFile = File(...),
    prompt: str = Form(default="Analyze this image in detail. Describe what you see, any text, charts, patterns, or trading-relevant information."),
    max_new_tokens: int = Form(default=1024)
):
    try:
        contents = await file.read()
        result = analyze_with_ollama(contents, prompt)
        return AnalysisResponse(success=True, result=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return AnalysisResponse(success=False, error=str(e))


@app.post("/analyze_base64")
async def analyze_base64(request: dict):
    try:
        image_data = request.get("image_base64", "")
        prompt = request.get("prompt", "Analyze this image in detail.")
        max_new_tokens = request.get("max_new_tokens", 1024)

        if not image_data:
            raise HTTPException(status_code=400, detail="No image_base64 provided")

        if image_data.startswith("data:image"):
            image_data = image_data.split(",")[1]

        image_bytes = base64.b64decode(image_data)
        result = analyze_with_ollama(image_bytes, prompt)
        return AnalysisResponse(success=True, result=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return AnalysisResponse(success=False, error=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8888)
