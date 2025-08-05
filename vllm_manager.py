#!/usr/bin/env python3
"""
Simple vLLM Manager - Run multiple models on different ports
"""

import os
import json
import subprocess as sp
import psutil
import socket
import base64
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
    
    def get_tool_parser_for_model(self, model_id: str) -> tuple[str, Optional[str]]:
        """Determine the appropriate tool parser and chat template for a model."""
        model_lower = model_id.lower()
        
        # Qwen models
        if 'qwen' in model_lower:
            if 'qwen3-coder' in model_lower:
                return "qwen3_coder", None  # Try qwen3_coder if it exists
            elif 'qwen2.5' in model_lower or 'qwq' in model_lower:
                return "hermes", None  # Qwen2.5 uses hermes
            else:
                return "hermes", None  # Default for other Qwen models
        
        # Mistral models
        elif 'mistral' in model_lower:
            return "mistral", "examples/tool_chat_template_mistral_parallel.jinja"
        
        # Llama models
        elif 'llama' in model_lower or 'meta-llama' in model_lower:
            if 'llama-4' in model_lower:
                return "llama4_pythonic", "examples/tool_chat_template_llama4_pythonic.jinja"
            elif 'llama-3.2' in model_lower:
                return "llama3_json", "examples/tool_chat_template_llama3.2_json.jinja"
            elif 'llama-3.1' in model_lower:
                return "llama3_json", "examples/tool_chat_template_llama3.1_json.jinja"
            else:
                return "llama3_json", None
        
        # InternLM models
        elif 'internlm' in model_lower:
            return "internlm", "examples/tool_chat_template_internlm2_tool.jinja"
        
        # Jamba models
        elif 'jamba' in model_lower:
            return "jamba", None
        
        # Granite models
        elif 'granite' in model_lower:
            if 'granite-20b-functioncalling' in model_lower:
                return "granite-20b-fc", "examples/tool_chat_template_granite_20b_fc.jinja"
            elif 'granite-3.0' in model_lower:
                return "granite", "examples/tool_chat_template_granite.jinja"
            else:
                return "granite", None
        
        # GPT-OSS models (OpenAI's open models with MXFP4 quantization)
        elif 'gpt-oss' in model_lower:
            return None, None  # Tool calling support unclear for GPT-OSS
        
        # DeepSeek models
        elif 'deepseek' in model_lower:
            if 'deepseek-r1' in model_lower:
                return "deepseek_v3", "examples/tool_chat_template_deepseekr1.jinja"
            elif 'deepseek-v3' in model_lower:
                return "deepseek_v3", "examples/tool_chat_template_deepseekv3.jinja"
            else:
                return "hermes", None  # Fallback for other DeepSeek models
        
        # xLAM models
        elif 'xlam' in model_lower:
            if 'llama-xlam' in model_lower:
                return "xlam", "examples/tool_chat_template_xlam_llama.jinja"
            else:
                return "xlam", "examples/tool_chat_template_xlam_qwen.jinja"
        
        # Phi models (Microsoft)
        elif 'phi' in model_lower:
            # Phi models don't have tool calling tokens, disable by default
            return None, None
        
        # Default fallback
        else:
            return "hermes", None
    
    def start(self, model_id: str, name: Optional[str] = None, max_len: Optional[int] = None, gpu_memory_utilization: float = None, tensor_parallel_size: int = 1, gpu_ids: Optional[str] = None):
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
        
        # Get appropriate tool parser for the model
        tool_parser, chat_template = self.get_tool_parser_for_model(model_id)
        
        # Start vLLM (use venv python if available)
        python_cmd = str(Path.home() / "vllm_env/bin/python3") if (Path.home() / "vllm_env/bin/python3").exists() else "python3"
        cmd = [
            python_cmd, "-u", "-m", "vllm.entrypoints.openai.api_server",
            "--model", model_id,
            "--host", "0.0.0.0",
            "--port", str(port),
            "--gpu-memory-utilization", str(gpu_memory_utilization)
        ]
        
        # Only add tool calling if a parser is available
        if tool_parser:
            print(f"Auto-detected tool parser: {tool_parser}" + (f" with chat template: {chat_template}" if chat_template else ""))
            cmd.extend([
                "--enable-auto-tool-choice",
                "--tool-call-parser", tool_parser
            ])
            # Add chat template if specified
            if chat_template:
                cmd.extend(["--chat-template", chat_template])
        else:
            print(f"Tool calling disabled for {model_id} (no compatible parser)")
        
        # Only add max-model-len if specified
        if max_len is not None:
            cmd.extend(["--max-model-len", str(max_len)])
        
        # Add tensor parallel size if > 1
        if tensor_parallel_size > 1:
            cmd.extend(["--tensor-parallel-size", str(tensor_parallel_size)])
        
        # Special handling for GPT-OSS models - disable V1 engine due to FlashInfer compatibility issues
        if 'gpt-oss' in model_id.lower():
            cmd.append("--disable-v1")
            print("Note: Disabling V1 engine for GPT-OSS model (FlashInfer compatibility)")
        
        # Use environment as-is (already configured by .pirc)
        env = os.environ.copy()
        
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
        
        
        # Open log file and start process
        with open(log_file, 'w') as f:
            f.write(f"=== Starting {model_id} at {datetime.now()} ===\n")
            f.write(f"Command: {' '.join(cmd)}\n")
            if tool_parser:
                f.write(f"Tool Parser: {tool_parser}\n")
                if chat_template:
                    f.write(f"Chat Template: {chat_template}\n")
            else:
                f.write(f"Tool Calling: Disabled (no compatible parser)\n")
            if gpu_ids:
                f.write(f"CUDA_VISIBLE_DEVICES: {gpu_ids}\n")
            if tensor_parallel_size > 1:
                f.write(f"Tensor Parallel Size: {tensor_parallel_size}\n")
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
    
    def start_raw(self, model_id: str, name: str, vllm_args: str):
        # Check if already running
        if name in self.models and self.is_running(self.models[name]['pid']):
            return self.models[name]
        
        # Find port
        port = self.find_free_port()
        
        # Create log file
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_file = LOGS_DIR / f"{name}_{timestamp}.log"
        
        # Start vLLM with raw arguments
        python_cmd = str(Path.home() / "vllm_env/bin/python3") if (Path.home() / "vllm_env/bin/python3").exists() else "python3"
        
        # Base command - ensure vllm_args is properly quoted
        cmd = f'{python_cmd} -u -m vllm.entrypoints.openai.api_server --model "{model_id}" --host 0.0.0.0 --port {port} {vllm_args}'
        
        # Use environment as-is (already configured by .pirc)
        env = os.environ.copy()
        
        
        # Open log file and start process
        with open(log_file, 'w') as f:
            f.write(f"=== Starting {model_id} at {datetime.now()} ===")
            f.write(f"\nCommand: {cmd}\n")
            f.write("=" * 60 + "\n\n")
            f.flush()
            
            # Use shell=True for the command string
            process = sp.Popen(
                cmd, 
                shell=True,
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
            "raw_args": vllm_args
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
        
        # Force kill all vLLM-related Python processes to ensure cleanup
        max_attempts = 5
        for attempt in range(max_attempts):
            try:
                # Get all python processes containing 'vllm'
                ps_result = sp.run(['ps', 'aux'], capture_output=True, text=True)
                vllm_pids = []
                
                for line in ps_result.stdout.split('\n'):
                    if 'python' in line and 'vllm' in line and 'vllm_manager.py' not in line:
                        # Extract PID (second column)
                        parts = line.split()
                        if len(parts) > 1:
                            vllm_pids.append(parts[1])
                
                if not vllm_pids:
                    break  # No vLLM processes found
                
                # Kill the vLLM processes
                for pid in vllm_pids:
                    try:
                        sp.run(['kill', '-9', pid], capture_output=True)
                    except:
                        pass
                
                # Small delay between attempts
                import time
                time.sleep(0.5)
            except:
                break
        
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
    
    def check_downloads(self):
        """Check model download progress in HuggingFace cache"""
        import glob
        import re
        
        # Respect HuggingFace environment variables
        if os.environ.get('HUGGINGFACE_HUB_CACHE'):
            cache_dir = Path(os.environ['HUGGINGFACE_HUB_CACHE'])
        elif os.environ.get('HF_HOME'):
            cache_dir = Path(os.environ['HF_HOME']) / "hub"
        else:
            cache_dir = Path.home() / ".cache" / "huggingface" / "hub"
        
        if not cache_dir.exists():
            return {"status": "NO_CACHE", "cache_dir": str(cache_dir)}
        
        model_dirs = list(cache_dir.glob("models--*"))
        if not model_dirs:
            return {"status": "NO_MODELS"}
        
        results = []
        
        for model_dir in model_dirs:
            # Extract model name
            model_name = model_dir.name.replace("models--", "").replace("--", "/")
            
            # Get size (only count actual blob files, not symlinks)
            total_size = 0
            blobs_dir = model_dir / "blobs"
            if blobs_dir.exists():
                for f in blobs_dir.iterdir():
                    if f.is_file() and not f.name.endswith('.incomplete'):
                        total_size += f.stat().st_size
            size_gb = total_size / (1024**3)
            
            # Count safetensors files in blobs directory (actual files)
            safetensors_count = 0
            snapshots_dir = model_dir / "snapshots"
            if snapshots_dir.exists():
                for snapshot in snapshots_dir.iterdir():
                    if snapshot.is_dir():
                        safetensors_count = len(list(snapshot.glob("*.safetensors")))
                        break  # Use first snapshot
            file_count = safetensors_count
            
            # Get total expected files from filename pattern
            total_files = 0
            if snapshots_dir.exists():
                for snapshot in snapshots_dir.iterdir():
                    if snapshot.is_dir():
                        for f in snapshot.glob("*.safetensors"):
                            match = re.search(r'model-\d+-of-(\d+)\.safetensors', f.name)
                            if match:
                                total_files = max(total_files, int(match.group(1)))
                        break  # Only check first snapshot
            
            # Check if actively downloading (check if any incomplete files exist in blobs)
            incomplete_files = []
            if blobs_dir.exists():
                incomplete_files = list(blobs_dir.glob("*.incomplete"))
            is_active = len(incomplete_files) > 0
            
            results.append({
                "model": model_name,
                "size_gb": round(size_gb, 1),
                "files": file_count,
                "total_files": total_files,
                "active": is_active
            })
        
        # Count vLLM processes
        vllm_count = 0
        for proc in psutil.process_iter(['pid', 'cmdline']):
            try:
                cmdline = ' '.join(proc.info['cmdline'] or [])
                if 'python' in cmdline and 'vllm' in cmdline and 'vllm_manager.py' not in cmdline:
                    vllm_count += 1
            except:
                pass
        
        return {
            "status": "OK",
            "models": results,
            "vllm_processes": vllm_count
        }

def main():
    import sys
    
    manager = VLLMManager()
    
    if len(sys.argv) < 2:
        print("Usage: vllm_manager.py [list|start|stop|logs|downloads] ...")
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
                print(f"\n  Export for OpenAI clients:")
                print(f"  export OPENAI_BASE_URL='http://{host_ip}:{info['port']}/v1'")
                print(f"  export OPENAI_API_KEY='dummy'")
                print(f"  export OPENAI_MODEL='{info['model_id']}'")
                if 'log_file' in info:
                    print(f"\n  Logs:  {info['log_file']}")
    
    elif cmd == "start":
        if len(sys.argv) < 3:
            print("Usage: vllm_manager.py start <model_id> [name] [max_len] [gpu_memory] [tensor_parallel_size]")
            sys.exit(1)
        
        model_id = sys.argv[2]
        name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ['""', ''] else None
        max_len = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] not in ['""', ''] else None
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
        print(f"export OPENAI_MODEL='{model_id}'")
    
    elif cmd == "start_raw":
        if len(sys.argv) < 5:
            print("Usage: vllm_manager.py start_raw <model_id> <name> <vllm_args>")
            sys.exit(1)
        
        model_id = sys.argv[2]
        name = sys.argv[3]
        vllm_args_base64 = sys.argv[4]
        
        # Decode base64 arguments
        vllm_args = base64.b64decode(vllm_args_base64).decode('utf-8')
        print(f"DEBUG: Decoded vllm_args: '{vllm_args}'")
        
        model_result = manager.start_raw(model_id, name, vllm_args)
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
        print(f"export OPENAI_MODEL='{model_id}'")
    
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
    
    elif cmd == "downloads":
        # Check if --stream flag is provided
        stream = len(sys.argv) > 2 and sys.argv[2] == "--stream"
        
        if stream:
            # Streaming mode - continuously output status
            import time
            import signal
            
            # Handle SIGTERM/SIGINT for clean shutdown
            def signal_handler(sig, frame):
                sys.exit(0)
            
            signal.signal(signal.SIGINT, signal_handler)
            signal.signal(signal.SIGTERM, signal_handler)
            
            while True:
                download_info = manager.check_downloads()
                
                if download_info["status"] == "NO_CACHE":
                    print(json.dumps({"status": "NO_CACHE", "message": "No HuggingFace cache found"}))
                elif download_info["status"] == "NO_MODELS":
                    print(json.dumps({"status": "NO_MODELS", "message": "No models in cache"}))
                else:
                    print(json.dumps(download_info))
                
                sys.stdout.flush()  # Force flush to ensure output is sent
                time.sleep(2)  # Update every 2 seconds
        else:
            # Single check mode
            download_info = manager.check_downloads()
            
            if download_info["status"] == "NO_CACHE":
                print("No HuggingFace cache found")
            elif download_info["status"] == "NO_MODELS":
                print("No models in cache")
            else:
                # Output as JSON for easy parsing
                print(json.dumps(download_info))
    
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

if __name__ == "__main__":
    main()