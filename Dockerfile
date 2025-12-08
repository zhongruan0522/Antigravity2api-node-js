# 使用官方 Node.js 镜像作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装项目依赖并清理缓存
RUN npm ci --only=production && \
    npm cache clean --force && \
    rm -rf /root/.npm

# 复制项目文件
COPY . .

# 根据架构下载对应的二进制文件
ARG TARGETPLATFORM
RUN echo "Building for platform: ${TARGETPLATFORM}" && \
    if [ "${TARGETPLATFORM}" = "linux/arm64" ]; then \
        echo "ARM64平台 - 使用Android ARM64二进制文件" && \
        cp src/bin/antigravity_requester_android_arm64 src/bin/antigravity_requester_linux_arm64 && \
        chmod +x src/bin/antigravity_requester_linux_arm64; \
    fi && \
    chmod +x src/bin/*_amd64 src/bin/*_arm64 2>/dev/null || true

# 创建 data 目录用于存储 accounts.json
RUN mkdir -p data && \
    chown -R node:node /app

# 暴露端口
EXPOSE 8045

# 设置环境变量默认值
ENV NODE_ENV=production
ENV PORT=8045
ENV HOST=0.0.0.0

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + process.env.PORT + '/healthz', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# 启动命令
CMD ["npm", "start"]
