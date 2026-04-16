#!/bin/bash
# detect-external.sh - Detect external system interactions in a project
# Usage: detect-external.sh <project_root> <output_dir> [profiler_yaml]
# Output (all written to output_dir):
#   external-candidates.txt  — full scan results
#   external-summary.txt     — per-category file count (~1KB)
#   external-index.txt       — per-category file:line list (no code)

set -euo pipefail

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${2:-.}"

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "ERROR: Directory not found: $PROJECT_ROOT" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Auto-extract project types from profiler
PROFILER="${3:-}"
if [ -f "$PROFILER" ] && command -v python3 &>/dev/null; then
    PROJECT_TYPES=$(python3 -c "
import yaml
with open('$PROFILER') as f:
    data = yaml.safe_load(f)
types = [k for k,v in data.get('project_type',{}).items() if isinstance(v,dict) and v.get('is_type')]
print(','.join(types))
" 2>/dev/null || echo "all")
else
    PROJECT_TYPES="all"
fi

# Redirect stdout to candidates file; status goes to fd3
CANDIDATES="$OUTPUT_DIR/external-candidates.txt"
exec 3>&1 1>"$CANDIDATES"

# Helper: check if a project type is enabled
has_type() {
    local t="$1"
    [ "$PROJECT_TYPES" = "all" ] && return 0
    echo ",$PROJECT_TYPES," | grep -q ",${t}," && return 0
    return 1
}

# Helper: print section header
print_header() {
    echo ""
    echo "EXTERNAL: $1"
}

# Helper: search single glob
search_pattern() {
    local client_name="$1"
    local pattern="$2"
    local file_glob="$3"

    local results
    results=$(grep -rn --include="$file_glob" \
        --exclude-dir=.venv --exclude-dir=venv --exclude-dir=node_modules \
        --exclude-dir=.git --exclude-dir=vendor --exclude-dir=__pycache__ \
        -E "$pattern" "$PROJECT_ROOT" 2>/dev/null || true)
    if [ -n "$results" ]; then
        echo "  CLIENT: $client_name"
        echo "$results" | while IFS= read -r line; do
            echo "    FILE: ${line#$PROJECT_ROOT/}"
        done
    fi
}

# Helper: multi-glob search
search_multi() {
    local client_name="$1"
    local pattern="$2"
    shift 2
    local globs=("$@")

    local results=""
    for glob in "${globs[@]}"; do
        local found
        found=$(grep -rn --include="$glob" \
            --exclude-dir=.venv --exclude-dir=venv --exclude-dir=node_modules \
            --exclude-dir=.git --exclude-dir=vendor --exclude-dir=__pycache__ \
            -E "$pattern" "$PROJECT_ROOT" 2>/dev/null || true)
        if [ -n "$found" ]; then
            results="${results}${found}"$'\n'
        fi
    done

    if [ -n "$results" ]; then
        echo "  CLIENT: $client_name"
        echo "$results" | grep -v '^$' | while IFS= read -r line; do
            echo "    FILE: ${line#$PROJECT_ROOT/}"
        done
    fi
}

echo "=== External Interaction Detection ==="
echo "Project: $PROJECT_ROOT"
echo ""

# ─────────────────────────────────────────────────────────────
# HTTP Clients
# ─────────────────────────────────────────────────────────────
print_header "HTTP_CLIENT"

# Java HTTP clients
search_pattern "HttpClient (Java)" \
    "(HttpClient|HttpURLConnection|CloseableHttpClient)" "*.java"
search_pattern "OkHttp (Java)" \
    "(OkHttpClient|Request\.Builder|okhttp3)" "*.java"
search_pattern "RestTemplate/WebClient (Java)" \
    "(RestTemplate|WebClient\.create|WebClient\.builder)" "*.java"
search_pattern "Feign / Retrofit (Java)" \
    "(import feign\.|import retrofit2\.)" "*.java"

# Python HTTP clients
search_multi "requests (Python)" \
    "(import requests|requests\.(get|post|put|delete|patch|head|request))" "*.py"
search_multi "httpx (Python)" \
    "(import httpx|httpx\.(get|post|AsyncClient))" "*.py"
search_multi "urllib (Python)" \
    "(urllib\.request\.(urlopen|Request)|urllib2\.urlopen)" "*.py"
search_multi "aiohttp (Python)" \
    "(import aiohttp|aiohttp\.ClientSession)" "*.py"

# Go HTTP clients
search_pattern "http.Get/Post (Go)" \
    '(http\.(Get|Post|Do|NewRequest)|&http\.Client\{)' "*.go"
search_pattern "resty / grequests (Go)" \
    '"github\.com/(go-resty|levigross/grequests)"' "*.go"

# JS/TS HTTP clients
search_multi "axios (JS/TS)" \
    "(require\(['\"]axios['\"]|from ['\"]axios['\"]|axios\.(get|post|put))" \
    "*.js" "*.ts" "*.mjs"
search_multi "fetch (JS/TS)" \
    "\bfetch\s*\(['\"]https?://" "*.js" "*.ts" "*.mjs"
search_multi "node-fetch (JS/TS)" \
    "(require\(['\"]node-fetch['\"]|from ['\"]node-fetch['\"])" "*.js" "*.ts"
search_multi "got (JS/TS)" \
    "(require\(['\"]got['\"]|from ['\"]got['\"])" "*.js" "*.ts"

# JS/TS framework HTTP service wrappers (Angular HttpClient, app-level service abstractions)
# Many frontend apps wrap raw HTTP clients in service layers (e.g. getBackendSrv().get(),
# this.http.get(), apiClient.post()). These do not match fetch/axios patterns.
search_multi "Angular HttpClient (JS/TS)" \
    "(this\.http\.(get|post|put|delete|patch|request)\(|HttpClient)" \
    "*.ts" "*.tsx"
search_multi "framework HTTP service wrapper (JS/TS)" \
    "(get[A-Z]\w*Srv\(\)\.(get|post|put|delete|fetch|request|datasourceRequest)\(|getBackendSrv\(\)|getDataSourceSrv\(\))" \
    "*.ts" "*.tsx" "*.js"
search_multi "app-level HTTP service (JS/TS)" \
    "(apiClient\.(get|post|put|delete)\(|apiService\.(get|post|put|delete)\(|httpService\.(get|post|put|delete)\(|\$http\.(get|post|put|delete)\()" \
    "*.ts" "*.tsx" "*.js" "*.vue"

# PHP HTTP clients
search_pattern "curl_exec (PHP)" \
    "(curl_init|curl_exec|curl_setopt)" "*.php"
search_pattern "Guzzle (PHP)" \
    "(GuzzleHttp\\\\Client|new Client\(\)|use GuzzleHttp)" "*.php"
search_pattern "file_get_contents URL (PHP)" \
    "file_get_contents\s*\(['\"]https?://" "*.php"

# ─────────────────────────────────────────────────────────────
# Database Drivers
# ─────────────────────────────────────────────────────────────
print_header "DATABASE"

# Java DB
search_pattern "JDBC (Java)" \
    "(DriverManager\.getConnection|DataSource|JdbcTemplate)" "*.java"
search_pattern "Hibernate/JPA (Java)" \
    "(EntityManager|SessionFactory|@Entity|createQuery)" "*.java"
search_pattern "MyBatis (Java)" \
    "(SqlSessionFactory|@Mapper|import org\.mybatis)" "*.java"

# Python DB
search_multi "SQLAlchemy (Python)" \
    "(import sqlalchemy|from sqlalchemy|create_engine)" "*.py"
search_multi "pymysql (Python)" \
    "(import pymysql|pymysql\.connect)" "*.py"
search_multi "psycopg2 (Python)" \
    "(import psycopg2|psycopg2\.connect)" "*.py"
search_multi "sqlite3 (Python)" \
    "(import sqlite3|sqlite3\.connect)" "*.py"
search_multi "pymongo (Python)" \
    "(import pymongo|MongoClient)" "*.py"
search_multi "redis-py (Python)" \
    "(import redis|redis\.Redis|redis\.StrictRedis)" "*.py"

# Go DB
search_pattern "database/sql (Go)" \
    '"database/sql"' "*.go"
search_pattern "gorm (Go)" \
    '"gorm\.io/gorm"' "*.go"
search_pattern "sqlx (Go)" \
    '"github\.com/jmoiron/sqlx"' "*.go"
search_pattern "go-redis (Go)" \
    '"github\.com/go-redis/redis' "*.go"
search_pattern "mongo-driver (Go)" \
    '"go\.mongodb\.org/mongo-driver' "*.go"

# JS/TS DB
search_multi "pg / node-postgres (JS/TS)" \
    "(require\(['\"]pg['\"]|from ['\"]pg['\"]|new Pool\(|new Client\()" "*.js" "*.ts"
search_multi "mysql2 (JS/TS)" \
    "(require\(['\"]mysql2['\"]|from ['\"]mysql2['\"])" "*.js" "*.ts"
search_multi "mongoose (JS/TS)" \
    "(require\(['\"]mongoose['\"]|from ['\"]mongoose['\"]|mongoose\.connect)" "*.js" "*.ts"
search_multi "sequelize (JS/TS)" \
    "(require\(['\"]sequelize['\"]|from ['\"]sequelize['\"]|new Sequelize)" "*.js" "*.ts"
search_multi "ioredis / redis (JS/TS)" \
    "(require\(['\"]ioredis['\"]|from ['\"]ioredis['\"]|new Redis\()" "*.js" "*.ts"
search_multi "typeorm (JS/TS)" \
    "(require\(['\"]typeorm['\"]|from ['\"]typeorm['\"]|createConnection)" "*.js" "*.ts"
search_multi "prisma (JS/TS)" \
    "(from ['\"]@prisma/client['\"]|new PrismaClient)" "*.js" "*.ts"

# PHP DB
search_pattern "PDO (PHP)" \
    "(new PDO\(|PDO::)" "*.php"
search_pattern "mysqli (PHP)" \
    "(mysqli_connect|new mysqli)" "*.php"

# ─────────────────────────────────────────────────────────────
# File System Operations with User-Controlled Paths
# ─────────────────────────────────────────────────────────────
print_header "FILESYSTEM_USER_INPUT"

# Java FS
search_pattern "File with variable path (Java)" \
    "new File\s*\(\s*(request|param|input|path|dir|name)" "*.java"
search_pattern "Files.read/write (Java)" \
    "(Files\.(readAllBytes|write|copy|move)|Paths\.get)" "*.java"

# Python FS
search_multi "open() with variable (Python)" \
    "open\s*\(\s*(request|param|path|filename|filepath|user)" "*.py"
search_multi "os.path operations (Python)" \
    "(os\.path\.(join|exists|isfile)|os\.(open|makedirs|remove))" "*.py"
search_multi "shutil with variable (Python)" \
    "(shutil\.(copy|move|rmtree))" "*.py"

# Go FS
search_pattern "os.Open/Create with variable (Go)" \
    "(os\.(Open|Create|OpenFile|ReadFile|WriteFile))" "*.go"
search_pattern "ioutil.ReadFile (Go)" \
    "ioutil\.(ReadFile|WriteFile)" "*.go"

# JS/TS FS
search_multi "fs.readFile with variable (JS/TS)" \
    "(fs\.(readFile|writeFile|appendFile|createReadStream|createWriteStream))" "*.js" "*.ts"
search_multi "path.join with user input (JS/TS)" \
    "path\.join\s*\(.*?(req\.|param|query|body|input)" "*.js" "*.ts"

# PHP FS
search_pattern "file operations with variable (PHP)" \
    "(file_get_contents|file_put_contents|fopen|include|require)\s*\(\s*\$" "*.php"

# ─────────────────────────────────────────────────────────────
# Message Queues
# ─────────────────────────────────────────────────────────────
print_header "MESSAGE_QUEUE"

# Java MQ
search_pattern "RabbitMQ (Java)" \
    "(ConnectionFactory|Channel|RabbitTemplate|import com\.rabbitmq)" "*.java"
search_pattern "Kafka (Java)" \
    "(KafkaProducer|KafkaConsumer|import org\.apache\.kafka)" "*.java"
search_pattern "ActiveMQ/JMS (Java)" \
    "(JMSTemplate|ConnectionFactory|import javax\.jms)" "*.java"
search_pattern "AWS SQS SDK (Java)" \
    "(AmazonSQS|SqsClient|import software\.amazon\.awssdk\.services\.sqs)" "*.java"

# Python MQ
search_multi "pika / RabbitMQ (Python)" \
    "(import pika|pika\.BlockingConnection|pika\.ConnectionParameters)" "*.py"
search_multi "confluent-kafka (Python)" \
    "(from confluent_kafka|import confluent_kafka)" "*.py"
search_multi "kafka-python (Python)" \
    "(from kafka import|KafkaProducer|KafkaConsumer)" "*.py"
search_multi "celery (Python)" \
    "(from celery|import celery|Celery\()" "*.py"
search_multi "boto3 SQS (Python)" \
    "(boto3.*sqs|client\(['\"]sqs['\"])" "*.py"

# Go MQ
search_pattern "amqp / RabbitMQ (Go)" \
    '"github\.com/streadway/amqp"' "*.go"
search_pattern "confluent-kafka-go (Go)" \
    '"github\.com/confluentinc/confluent-kafka-go' "*.go"
search_pattern "aws-sdk-go SQS (Go)" \
    '"github\.com/aws/aws-sdk-go.*sqs"' "*.go"

# JS/TS MQ
search_multi "amqplib / RabbitMQ (JS/TS)" \
    "(require\(['\"]amqplib['\"]|from ['\"]amqplib['\"])" "*.js" "*.ts"
search_multi "kafkajs (JS/TS)" \
    "(require\(['\"]kafkajs['\"]|from ['\"]kafkajs['\"])" "*.js" "*.ts"
search_multi "bull / BullMQ (JS/TS)" \
    "(require\(['\"]bull['\"]|from ['\"]bull['\"]|require\(['\"]bullmq['\"])" "*.js" "*.ts"
search_multi "Redis pub/sub (JS/TS)" \
    "(\.subscribe\(|\.publish\(|\.psubscribe\()" "*.js" "*.ts"

# ─────────────────────────────────────────────────────────────
# Cloud SDKs
# ─────────────────────────────────────────────────────────────
print_header "CLOUD_SDK"

# AWS
search_multi "aws-sdk / boto3 (Python)" \
    "(import boto3|boto3\.(client|resource|session))" "*.py"
search_multi "aws-sdk-js (JS/TS)" \
    "(require\(['\"]@aws-sdk/|from ['\"]@aws-sdk/|require\(['\"]aws-sdk['\"])" "*.js" "*.ts"
search_pattern "aws-sdk-go (Go)" \
    '"github\.com/aws/aws-sdk-go' "*.go"
search_pattern "AWS SDK Java" \
    "import software\.amazon\.awssdk\." "*.java"

# Google Cloud
search_multi "google-cloud (Python)" \
    "(from google\.cloud|import google\.cloud)" "*.py"
search_multi "google-cloud (JS/TS)" \
    "(require\(['\"]@google-cloud/|from ['\"]@google-cloud/)" "*.js" "*.ts"
search_pattern "google-cloud (Go)" \
    '"cloud\.google\.com/go' "*.go"
search_pattern "google-cloud (Java)" \
    "import com\.google\.cloud\." "*.java"

# Azure
search_multi "azure-sdk (Python)" \
    "(from azure\.|import azure\.)" "*.py"
search_multi "azure-sdk (JS/TS)" \
    "(require\(['\"]@azure/|from ['\"]@azure/)" "*.js" "*.ts"
search_pattern "azure-sdk (Go)" \
    '"github\.com/Azure/azure-sdk-for-go' "*.go"
search_pattern "azure-sdk (Java)" \
    "import com\.azure\." "*.java"

# ─────────────────────────────────────────────────────────────
# Email / SMTP
# ─────────────────────────────────────────────────────────────
print_header "EMAIL"

# Java Email
search_pattern "JavaMail (Java)" \
    "(import javax\.mail\.|Session\.getDefaultInstance|Transport\.send)" "*.java"
search_pattern "Spring Mail (Java)" \
    "(JavaMailSender|SimpleMailMessage|MimeMessage)" "*.java"

# Python Email
search_multi "smtplib (Python)" \
    "(import smtplib|smtplib\.SMTP)" "*.py"
search_multi "emails / yagmail (Python)" \
    "(import yagmail|import emails)" "*.py"
search_multi "sendgrid (Python)" \
    "(import sendgrid|from sendgrid)" "*.py"

# Go Email
search_pattern "gomail (Go)" \
    '"gopkg\.in/gomail' "*.go"
search_pattern "net/smtp (Go)" \
    '"net/smtp"' "*.go"

# JS/TS Email
search_multi "nodemailer (JS/TS)" \
    "(require\(['\"]nodemailer['\"]|from ['\"]nodemailer['\"]|createTransport)" "*.js" "*.ts"
search_multi "sendgrid (JS/TS)" \
    "(require\(['\"]@sendgrid/mail['\"]|from ['\"]@sendgrid/mail['\"])" "*.js" "*.ts"

# PHP Email
search_pattern "mail() (PHP)" \
    "\bmail\s*\(" "*.php"
search_pattern "sendmail (PHP)" \
    "sendmail" "*.php"
search_pattern "PHPMailer (PHP)" \
    "(PHPMailer|use PHPMailer)" "*.php"

# ─────────────────────────────────────────────────────────────
# DNS Lookups
# ─────────────────────────────────────────────────────────────
print_header "DNS"

# Java DNS
search_pattern "InetAddress.getByName (Java)" \
    "(InetAddress\.getByName|InetAddress\.getAllByName)" "*.java"

# Python DNS
search_multi "socket.getaddrinfo (Python)" \
    "(socket\.gethostbyname|socket\.getaddrinfo|dns\.resolver)" "*.py"
search_multi "dnspython (Python)" \
    "(import dns\.|from dns\.)" "*.py"

# Go DNS
search_pattern "net.LookupHost (Go)" \
    "(net\.LookupHost|net\.LookupAddr|net\.Dial)" "*.go"

# JS/TS DNS
search_multi "dns.lookup (JS/TS)" \
    "(dns\.(lookup|resolve|reverse)|require\(['\"]dns['\"])" "*.js" "*.ts"
search_multi "node:dns (JS/TS)" \
    'from "node:dns"' "*.js" "*.ts" "*.mjs"

# PHP DNS
search_pattern "gethostbyname (PHP)" \
    "(gethostbyname|dns_get_record|checkdnsrr)" "*.php"

# ─────────────────────────────────────────────────────────────
# gRPC / RPC
# ─────────────────────────────────────────────────────────────
print_header "GRPC_RPC"

search_pattern "gRPC (Java)" \
    "(ManagedChannel|ManagedChannelBuilder|import io\.grpc)" "*.java"
search_multi "grpcio (Python)" \
    "(import grpc|grpc\.insecure_channel|grpc\.secure_channel)" "*.py"
search_pattern "grpc (Go)" \
    '"google\.golang\.org/grpc"' "*.go"
search_multi "@grpc/grpc-js (JS/TS)" \
    "(require\(['\"]@grpc/grpc-js['\"]|from ['\"]@grpc/grpc-js['\"])" "*.js" "*.ts"

# ─────────────────────────────────────────────────────────────
# Framework Agent/Tool Implicit Code Execution
# ─────────────────────────────────────────────────────────────
print_header "AGENT_CODE_EXECUTION"

# LangChain dangerous flags (Python)
search_multi "allow_dangerous_code (Python)" \
    "allow_dangerous_code\s*=\s*True" "*.py"
search_multi "allow_dangerous_requests (Python)" \
    "allow_dangerous_requests\s*=\s*True" "*.py"

# LangChain agent factory functions (Python)
search_multi "create_csv_agent (Python)" \
    "(create_csv_agent|create_pandas_dataframe_agent|create_spark_dataframe_agent)" "*.py"

# LangChain code execution tools (Python)
search_multi "PythonREPL tools (Python)" \
    "(PythonREPL|PythonREPLTool|PythonAstREPLTool)" "*.py"

# Generic dangerous mode flags (all languages)
search_multi "sandbox disable flags (Python)" \
    "(sandbox\s*=\s*False|safe_mode\s*=\s*False|restricted\s*=\s*False)" "*.py"
search_multi "sandbox disable flags (JS/TS)" \
    "(sandbox\s*[:=]\s*false|safeMode\s*[:=]\s*false)" "*.js" "*.ts"

# ─────────────────────────────────────────────────────────────
# Command / Process Execution
# ─────────────────────────────────────────────────────────────
print_header "COMMAND_EXECUTION"

# PHP
search_pattern "PHP shell_exec / exec / system / passthru / popen" \
    "shell_exec\(|exec\(|system\(|passthru\(|popen\(|proc_open\(" "*.php"

# Python
search_multi "Python subprocess / os.system / os.popen" \
    "subprocess\.|os\.system\(|os\.popen\(|os\.exec" \
    "*.py"

# Java
search_multi "Java Runtime.exec / ProcessBuilder" \
    "Runtime\.getRuntime\(\)\.exec|ProcessBuilder|\.exec\(" \
    "*.java" "*.kt"

# Go
search_pattern "Go os/exec" \
    "exec\.Command\(|exec\.CommandContext\(" "*.go"

# Node.js
search_multi "Node.js child_process / exec / spawn" \
    "child_process|\.exec\(|\.spawn\(|\.execFile\(|\.execSync\(" \
    "*.js" "*.ts"

# Ruby / Perl / Shell embedding
search_multi "Ruby / Perl system / exec / backtick" \
    "system\(|Kernel\.exec\(|\`.*\\$" \
    "*.rb" "*.pl"

# C/C++
search_multi "C/C++ system / popen / execve" \
    "\bsystem\(|\bpopen\(|\bexecve\(|\bexecvp\(|\bexeclp\(" \
    "*.c" "*.cpp" "*.h"

# ─────────────────────────────────────────────────────────────
# LDAP / Directory Service
# ─────────────────────────────────────────────────────────────
print_header "LDAP_DIRECTORY"

# PHP
search_pattern "PHP LDAP" \
    "ldap_search\(|ldap_bind\(|ldap_connect\(|ldap_read\(" "*.php"

# Java
search_multi "Java LDAP (JNDI / LdapContext)" \
    "LdapContext|InitialDirContext|DirContext|javax\.naming\.ldap" \
    "*.java" "*.kt"

# Python
search_multi "Python LDAP (ldap3 / python-ldap)" \
    "ldap3\.Connection|ldap\.initialize|ldap_filter\." \
    "*.py"

# Go
search_pattern "Go LDAP" \
    "ldap\.Dial\(|ldap\.DialURL\(" "*.go"

# Node.js
search_multi "Node.js LDAP (ldapjs)" \
    "ldap\.createClient|ldapjs" \
    "*.js" "*.ts"

# ─────────────────────────────────────────────────────────────
# Dynamic Library Loading
# ─────────────────────────────────────────────────────────────
print_header "DYNAMIC_LIB_LOAD"

# C/C++
search_multi "C/C++ dlopen / dlsym / LoadLibrary" \
    "\bdlopen\(|\bdlsym\(|LoadLibrary\(|LoadLibraryEx\(|GetProcAddress\(" \
    "*.c" "*.cpp" "*.h" "*.hpp"

# Python
search_multi "Python ctypes / cffi" \
    "ctypes\.cdll|ctypes\.CDLL|ctypes\.windll|ffi\.dlopen" \
    "*.py"

# Go
search_pattern "Go plugin.Open" \
    "plugin\.Open\(" "*.go"

# Java
search_multi "Java System.loadLibrary / System.load" \
    "System\.loadLibrary\(|System\.load\(|Runtime\.load\(" \
    "*.java" "*.kt"

# Node.js
search_multi "Node.js native addon / ffi-napi" \
    "ffi-napi|require\(['\"]\..*\.node['\"]|dlopen\(" \
    "*.js" "*.ts"

# ─────────────────────────────────────────────────────────────
# Mobile outbound IPC / Binder / Intent
# ─────────────────────────────────────────────────────────────
if has_type "mobile_app"; then
print_header "MOBILE_OUTBOUND"

# Android Binder / ContentResolver / Intent outbound
search_multi "Android Binder.transact / ContentResolver" \
    "\.transact\(|ContentResolver\.(query|insert|update|delete)\(" \
    "*.java" "*.kt"

search_multi "Android startActivity / sendBroadcast / startService" \
    "startActivity\(|sendBroadcast\(|startService\(|bindService\(" \
    "*.java" "*.kt"

# iOS outbound
search_multi "iOS openURL / UIApplication shared" \
    "UIApplication\.shared\.open\(|canOpenURL\(|openURL\(" \
    "*.swift" "*.m"
fi

# ─────────────────────────────────────────────────────────────
# Smart contract Oracle / cross-chain calls
# ─────────────────────────────────────────────────────────────
if has_type "smart_contract"; then
print_header "SMART_CONTRACT_ORACLE"

search_pattern "Chainlink / custom Oracle interface" \
    "latestAnswer\(|latestRoundData\(|requestRandomness\(|fulfillRandomness\(" "*.sol"

search_pattern "Cross-chain bridge callbacks (LayerZero / Axelar)" \
    "lzReceive\(|_nonblockingLzReceive\(|execute\(" "*.sol"

search_pattern "Low-level external calls (delegatecall / staticcall)" \
    "\.delegatecall\(|\.staticcall\(|\.call\{" "*.sol"
fi

# ─────────────────────────────────────────────────────────────
# Desktop application system calls
# ─────────────────────────────────────────────────────────────
if has_type "desktop_app"; then
print_header "DESKTOP_SYSTEM_CALL"

# Electron
search_multi "Electron shell.openExternal / app.getPath" \
    "shell\.openExternal\(|app\.getPath\(" \
    "*.js" "*.ts"

# Qt
search_multi "Qt QProcess / QNetworkAccessManager" \
    "QProcess::start\(|QProcess::execute\(|QNetworkAccessManager" \
    "*.cpp" "*.h" "*.hpp"
fi

# ─────────────────────────────────────────────────────────────
# TCP/UDP outbound connections
# ─────────────────────────────────────────────────────────────
print_header "TCP_OUTBOUND"

search_pattern "Go net.Dial / net.DialTCP" \
    "net\.Dial\(|net\.DialTCP\(|net\.DialUDP\(|net\.DialTimeout\(" "*.go"

search_multi "C/C++ connect / getaddrinfo / sendto" \
    "\bconnect\(|\bgetaddrinfo\(|\bsendto\(" \
    "*.c" "*.cpp" "*.h"

search_multi "Java Socket / DatagramSocket outbound" \
    "new\s+Socket\(|new\s+DatagramSocket\(|SocketChannel\.open\(" \
    "*.java" "*.kt"

search_pattern "Rust TcpStream::connect / UdpSocket::send_to" \
    "TcpStream::connect\(|UdpSocket::send_to\(" "*.rs"

# ─────────────────────────────────────────────────────────────
# Command execution in standalone scripts (data collection/processing)
# ─────────────────────────────────────────────────────────────
print_header "SCRIPT_CMD_EXEC"

# Search specifically in script/cron/job directories for command execution
for dir in scripts bin cron jobs tasks collectors pollers lib/scripts helpers/scripts; do
    target_dir="$PROJECT_ROOT/$dir"
    if [ -d "$target_dir" ]; then
        # PHP
        results=$(grep -rn --include="*.php" -E "shell_exec\(|exec\(|system\(|passthru\(|popen\(|proc_open\(" "$target_dir" 2>/dev/null || true)
        if [ -n "$results" ]; then
            echo "  CLIENT: Script cmd exec (PHP) in $dir/"
            echo "$results" | while IFS= read -r line; do
                echo "    FILE: ${line#$PROJECT_ROOT/}"
            done
        fi
        # Python
        results=$(grep -rn --include="*.py" -E "subprocess\.|os\.system\(|os\.popen\(" "$target_dir" 2>/dev/null || true)
        if [ -n "$results" ]; then
            echo "  CLIENT: Script cmd exec (Python) in $dir/"
            echo "$results" | while IFS= read -r line; do
                echo "    FILE: ${line#$PROJECT_ROOT/}"
            done
        fi
        # Shell scripts with external data
        results=$(grep -rn --include="*.sh" --include="*.bash" -E "\$\(|eval\s|\`" "$target_dir" 2>/dev/null || true)
        if [ -n "$results" ]; then
            echo "  CLIENT: Script cmd exec (Shell) in $dir/"
            echo "$results" | while IFS= read -r line; do
                echo "    FILE: ${line#$PROJECT_ROOT/}"
            done
        fi
        # Ruby/Perl
        results=$(grep -rn --include="*.rb" --include="*.pl" -E "system\(|exec\(|\`.*\\$|%x\(" "$target_dir" 2>/dev/null || true)
        if [ -n "$results" ]; then
            echo "  CLIENT: Script cmd exec (Ruby/Perl) in $dir/"
            echo "$results" | while IFS= read -r line; do
                echo "    FILE: ${line#$PROJECT_ROOT/}"
            done
        fi
    fi
done

# ─────────────────────────────────────────────────────────────
# Dynamic code evaluation (eval / Function / vm.run / exec / compile)
# ─────────────────────────────────────────────────────────────
print_header "DYNAMIC_CODE_EVAL"

# JS/TS standard dynamic code evaluation APIs
search_multi "JS/TS dynamic code evaluation (standard APIs)" \
    "\beval\(|new\s+Function\(|setTimeout\(\s*['\"]|setInterval\(\s*['\"]|vm\.runIn|vm\.compileFunction|vm\.Script\(|vm\.createContext" \
    "*.js" "*.ts" "*.mjs" "*.cjs" "*.jsx" "*.tsx"

# Python standard dynamic code evaluation APIs
search_multi "Python dynamic code evaluation (standard APIs)" \
    "\beval\(|\bexec\(|\bcompile\(|__import__\(|importlib\.import_module" \
    "*.py"

# Ruby standard dynamic code evaluation APIs
search_multi "Ruby dynamic code evaluation (standard APIs)" \
    "\beval\(|instance_eval|class_eval|module_eval|binding\.eval" \
    "*.rb"

# PHP standard dynamic code evaluation APIs
search_multi "PHP dynamic code evaluation (standard APIs)" \
    "\beval\(|create_function\(|assert\(\s*\\\$|preg_replace.*\\/e" \
    "*.php"

# Java reflection / script engine
search_multi "Java reflection / script engine" \
    "ScriptEngine|Nashorn|GraalVM|Method\.invoke|Class\.forName.*newInstance" \
    "*.java" "*.kt" "*.scala"

# Go reflection / plugin
search_multi "Go reflect.Call / plugin.Open" \
    "reflect\.Value.*Call|plugin\.Open|plugin\.Lookup" \
    "*.go"

echo ""
echo "=== Detection Complete ==="

# ─────────────────────────────────────────────────────────────
# Restore stdout; post-process candidates → summary + index
# ─────────────────────────────────────────────────────────────
exec 1>&3 3>&-

SUMMARY="$OUTPUT_DIR/external-summary.txt"
INDEX="$OUTPUT_DIR/external-index.txt"

awk '
/^EXTERNAL: / {
    if (cat != "") printf "  %-40s %d files\n", cat, count
    cat=substr($0,11); count=0; next
}
/^    FILE: / { count++; total++ }
END {
    if (cat != "") printf "  %-40s %d files\n", cat, count
    printf "\nTotal: %d file references\n", total
}
' "$CANDIDATES" > "$SUMMARY" 2>/dev/null || true

awk '
/^EXTERNAL: / { cat=substr($0,11); last_cat=""; next }
/^    FILE: / {
    line=substr($0,11)
    sub(/^ +/, "", line)
    n=split(line, parts, ":")
    if (n >= 2) {
        if (cat != last_cat) { printf "\n[%s]\n", cat; last_cat=cat }
        printf "%s:%s\n", parts[1], parts[2]
    }
}
' "$CANDIDATES" > "$INDEX" 2>/dev/null || true

echo "types=$PROJECT_TYPES"
echo "external-candidates.txt: $(wc -l < "$CANDIDATES") lines"
echo "external-summary.txt: $(wc -l < "$SUMMARY") lines"
echo "external-index.txt: $(wc -l < "$INDEX") lines"
