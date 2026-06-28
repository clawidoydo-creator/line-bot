# 使用官方 Node.js 輕量版作為基礎映像檔
FROM node:18-slim

# 設定容器內的工作目錄
WORKDIR /usr/src/app

# 複製 package.json 並安裝套件
COPY package.json ./
RUN npm install --production

# 複製其餘的原始碼
COPY . .

# 告知 Cloud Run 服務會監聽 8080 Port
EXPOSE 8080

# 啟動應用程式
CMD [ "node", "index.js" ]

