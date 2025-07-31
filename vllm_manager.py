#!/usr/bin/env python3
"""
Simple vLLM Manager - Run multiple models on different ports
"""

import os
import json
import subprocess as sp
import psutil
import socket
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime

# Config
CONFIG_FILE = Path.home() / ".vllm_manager.json"
LOGS_DIR = Path.home() / ".vllm_logs"
BASE_PORT = 8001  # Start from 8001, leave 8000 free

class VLLMManager:
    def __init__(self):
        self.models = {}  # name -> {pid, port, model_id, log_file}
        self.load()
        LOGS_DIR.mkdir(exist_ok=True)
    
    def load(self):
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE) as f:
                self.models = json.load(f)
    
    def save(self):
        with open(CONFIG_FILE, "w") as f:
            json.dump(self.models, f, indent=2)
    
    def is_running(self, pid: int) -> bool:
        try:
            process = psutil.Process(pid)
            return process.is_running()
        except:
            return False
    
    def find_free_port(self) -> int:
        used_ports = {info['port'] for info in self.models.values()}
        for port in range(BASE_PORT, BASE_PORT + 10):
            if port not in used_ports:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    try:
                        s.bind(('', port))
                        return port
                    except:
                        continue
        raise Exception("No free ports")
    
    def get_gpu_count(self) -> int:
        try:
            result = sp.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'], 
                          capture_output=True, text=True)
            if result.returncode == 0:
                return len(result.stdout.strip().split('\n'))
        except:
            pass
        return 1
    
    def find_available_gpu(self) -> Optional[int]:
        """Find the next available GPU that's not heavily used"""
        gpu_count = self.get_gpu_count()
        if gpu_count == 1:
            return None  # Let vLLM use default
        
        # Get GPUs used by our models
        used_gpus = set()
        for info in self.models.values():
            if 'gpu_id' in info:
                used_gpus.add(info['gpu_id'])
        
        # Find first unused GPU
        for gpu_id in range(gpu_count):
            if gpu_id not in used_gpus:
                return gpu_id
        
        # If all GPUs have at least one model, find the least loaded
        # For now, just cycle through
        return len(self.models) % gpu_count
    
    def list(self):
        # Clean up dead processes
        to_remove = []
        for name, info in self.models.items():
            if not self.is_running(info['pid']):
                to_remove.append(name)
        
        for name in to_remove:
            del self.models[name]
        
        if to_remove:
            self.save()
        
        return self.models
    
    def start(self, model_id: str, name: Optional[str] = None, max_len: int = 8192, gpu_memory_utilization: float = None, tensor_parallel_size: int = 1, gpu_ids: Optional[str] = None):
        # Generate name
        if not name:
            name = model_id.split('/')[-1].lower().replace('-', '_')
        
        # Check if already running
        if name in self.models and self.is_running(self.models[name]['pid']):
            return self.models[name]
        
        # Find port
        port = self.find_free_port()
        
        # Create log file
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_file = LOGS_DIR / f"{name}_{timestamp}.log"
        
        # Set GPU memory utilization if not specified
        if gpu_memory_utilization is None:
            print("WARNING: No GPU memory utilization specified, defaulting to 90%")
            print("         Consider specifying based on model size to run multiple models")
            print("         Examples: 0.2 for small models, 0.5 for medium, 0.9 for large")
            gpu_memory_utilization = 0.9
        
        # Start vLLM (use venv python if available)
        python_cmd = str(Path.home() / "vllm_env/bin/python3") if (Path.home() / "vllm_env/bin/python3").exists() else "python3"
        cmd = [
            python_cmd, "-m", "vllm.entrypoints.openai.api_server",
            "--model", model_id,
            "--host", "0.0.0.0",
            "--port", str(port),
            "--max-model-len", str(max_len),
            "--gpu-memory-utilization", str(gpu_memory_utilization),
            "--enable-auto-tool-choice",
            "--tool-call-parser", "hermes"
        ]
        
        # Add tensor parallel size if > 1
        if tensor_parallel_size > 1:
            cmd.extend(["--tensor-parallel-size", str(tensor_parallel_size)])
        
        # Get environment with correct HF token
        env = os.environ.copy()
        
        # Disable vLLM telemetry
        env['VLLM_NO_USAGE_STATS'] = '1'
        
        # Handle GPU assignment
        assigned_gpu = None
        if tensor_parallel_size > 1:
            # Multi-GPU: use all GPUs
            gpu_count = self.get_gpu_count()
            if tensor_parallel_size > gpu_count:
                print(f"Warning: Requested {tensor_parallel_size} GPUs but only {gpu_count} available")
                tensor_parallel_size = gpu_count
        else:
            # Single GPU: find available GPU
            if gpu_ids:
                env['CUDA_VISIBLE_DEVICES'] = gpu_ids
                assigned_gpu = int(gpu_ids.split(',')[0])
            else:
                assigned_gpu = self.find_available_gpu()
                if assigned_gpu is not None:
                    env['CUDA_VISIBLE_DEVICES'] = str(assigned_gpu)
                    print(f"Auto-assigned to GPU {assigned_gpu}")
        
        # Try to read tokens from bashrc first
        bashrc_file = Path.home() / ".bashrc"
        if bashrc_file.exists():
            with open(bashrc_file, 'r') as f:
                for line in f:
                    if line.strip().startswith('export ') and ('HF_TOKEN' in line or 'HUGGING_FACE' in line):
                        key_value = line.strip()[7:]  # Remove 'export '
                        if '=' in key_value:
                            key, value = key_value.split('=', 1)
                            env[key] = value.strip('"')
        
        # Also check token file (legacy support)
        token_file = Path.home() / ".hf_token"
        if token_file.exists():
            with open(token_file, 'r') as f:
                for line in f:
                    if line.strip().startswith('export '):
                        key_value = line.strip()[7:]  # Remove 'export '
                        if '=' in key_value:
                            key, value = key_value.split('=', 1)
                            env[key] = value.strip('"')
        
        # Open log file and start process
        with open(log_file, 'w') as f:
            f.write(f"=== Starting {model_id} at {datetime.now()} ===\n")
            f.write(f"Command: {' '.join(cmd)}\n")
            if gpu_ids:
                f.write(f"CUDA_VISIBLE_DEVICES: {gpu_ids}\n")
            if tensor_parallel_size > 1:
                f.write(f"Tensor Parallel Size: {tensor_parallel_size}\n")
            # Never log tokens for security
            hf_token_status = "SET" if env.get('HF_TOKEN') else "NOT SET"
            hf_hub_token_status = "SET" if env.get('HUGGING_FACE_HUB_TOKEN') else "NOT SET"
            f.write(f"HF_TOKEN: {hf_token_status}\n")
            f.write(f"HUGGING_FACE_HUB_TOKEN: {hf_hub_token_status}\n")
            f.write("=" * 60 + "\n\n")
            f.flush()
            
            process = sp.Popen(
                cmd, 
                stdout=f, 
                stderr=sp.STDOUT,  # Merge stderr into stdout
                bufsize=1,  # Line buffered
                universal_newlines=True,
                env=env  # Pass the modified environment
            )
        
        # Save info
        self.models[name] = {
            "pid": process.pid,
            "port": port,
            "model_id": model_id,
            "log_file": str(log_file),
            "gpu_id": assigned_gpu,
            "tensor_parallel_size": tensor_parallel_size if tensor_parallel_size > 1 else 1
        }
        self.save()
        
        return {"name": name, "port": port, "pid": process.pid, "log_file": str(log_file)}
    
    def stop(self, name: str):
        if name not in self.models:
            return False
        
        info = self.models[name]
        try:
            process = psutil.Process(info['pid'])
            process.terminate()
            process.wait(timeout=5)
        except:
            pass
        
        del self.models[name]
        self.save()
        return True
    
    def logs(self, name: str, lines: int = 50):
        if name not in self.models:
            return None
        
        log_file = self.models[name].get('log_file')
        if not log_file or not Path(log_file).exists():
            return None
        
        # Read last N lines
        with open(log_file, 'r') as f:
            all_lines = f.readlines()
            return ''.join(all_lines[-lines:])

def main():
    import sys
    
    manager = VLLMManager()
    
    if len(sys.argv) < 2:
        print("Usage: vllm_manager.py [list|start|stop|logs] ...")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "list":
        models = manager.list()
        if not models:
            print("No models running")
        else:
            # Get external IP
            try:
                # Try to get IP from default interface
                result = sp.run(['hostname', '-I'], capture_output=True, text=True)
                if result.returncode == 0 and result.stdout.strip():
                    host_ip = result.stdout.strip().split()[0]
                else:
                    host_ip = socket.gethostbyname(socket.gethostname())
            except:
                host_ip = socket.gethostbyname(socket.gethostname())
            print(f"Running models:")
            for name, info in models.items():
                print(f"\n{name}:")
                print(f"  Model: {info['model_id']}")
                print(f"  HF:    https://huggingface.co/{info['model_id']}")
                print(f"  Port:  {info['port']}")
                if 'tensor_parallel_size' in info and info.get('tensor_parallel_size', 1) > 1:
                    print(f"  GPUs:  {info.get('tensor_parallel_size', 1)} (tensor parallel)")
                elif 'gpu_id' in info and info['gpu_id'] is not None:
                    print(f"  GPU:   {info['gpu_id']}")
                print(f"  URL:   http://{host_ip}:{info['port']}/v1")
                if 'log_file' in info:
                    print(f"  Logs:  {info['log_file']}")
    
    elif cmd == "start":
        if len(sys.argv) < 3:
            print("Usage: vllm_manager.py start <model_id> [name] [max_len] [gpu_memory] [tensor_parallel_size]")
            sys.exit(1)
        
        model_id = sys.argv[2]
        name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != '""' else None
        max_len = int(sys.argv[4]) if len(sys.argv) > 4 else 8192
        gpu_memory = float(sys.argv[5]) if len(sys.argv) > 5 else None
        tensor_parallel = int(sys.argv[6]) if len(sys.argv) > 6 else 1
        
        model_result = manager.start(model_id, name, max_len, gpu_memory, tensor_parallel)
        # Get external IP
        try:
            # Try to get IP from default interface
            ip_result = sp.run(['hostname', '-I'], capture_output=True, text=True)
            if ip_result.returncode == 0 and ip_result.stdout.strip():
                host_ip = ip_result.stdout.strip().split()[0]
            else:
                host_ip = socket.gethostbyname(socket.gethostname())
        except:
            host_ip = socket.gethostbyname(socket.gethostname())
        
        print(f"Started {model_result['name']}")
        print(f"URL: http://{host_ip}:{model_result['port']}/v1")
        print(f"\nExport for OpenAI clients:")
        print(f"export OPENAI_BASE_URL='http://{host_ip}:{model_result['port']}/v1'")
    
    elif cmd == "stop":
        if len(sys.argv) < 3:
            print("Usage: vllm_manager.py stop <name>")
            sys.exit(1)
        
        name = sys.argv[2]
        if manager.stop(name):
            print(f"Stopped {name}")
        else:
            print(f"Model {name} not found")
    
    elif cmd == "logs":
        if len(sys.argv) < 3:
            print("Usage: vllm_manager.py logs <name> [lines]")
            sys.exit(1)
        
        name = sys.argv[2]
        lines = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        
        logs = manager.logs(name, lines)
        if logs is None:
            print(f"No logs found for {name}")
        else:
            print(logs, end='')
    
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

if __name__ == "__main__":
    main()