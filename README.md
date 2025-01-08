This app is hosted by using serverless framework

npm cache clean --force
npm install --legacy-peer-deps
npm install --save-dev serverless-offline serverless-dotenv-plugin --force
serverless remove
serverless deploy
