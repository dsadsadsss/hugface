# 使用 Alpine Linux 基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json (如果存在)
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用程序文件
COPY index.js ./

# 更改文件所有者为应用用户
RUN chown -R node:node /app

# 切换到非root用户
USER 1000

# 暴露端口
EXPOSE 7860

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:7860/health || exit 1

# 启动应用
CMD ["node", "index.js"]