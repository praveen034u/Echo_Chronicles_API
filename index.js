const express = require('express');
const serverless = require('aws-serverless-express');
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { body, validationResult } = require('express-validator');
const cors = require('cors');

const app = express();

// Enable CORS for all the routes
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Amz-Date', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Initialize Bedrock client
const bedrockClient = new BedrockRuntimeClient({ 
  region: process.env.AWS_REGION || "us-east-1"
});

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

// Validation middleware
const validateSession = [
  body('username').isString().notEmpty(),
  body('sessionid').isNumeric(),
];

// Save score endpoint
app.post('/savesession', validateSession, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, sessionid } = req.body;
    
    const command = new PutCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        username,
        sessionid: Number(sessionid),
        timestamp: new Date().toISOString()
      }
    });

    await docClient.send(command);
    res.status(201).json({ message: 'Score saved successfully' });
  } catch (error) {
    console.error('Error saving score:', error);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// Get user score endpoint
app.get('/getsessions:username', async (req, res) => {
  try {
    const command = new GetCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Key: {
        username: req.params.username
      }
    });

    const response = await docClient.send(command);
    if (!response.Item) {
      return res.status(404).json({ message: 'Session not found' });
    }
    res.json(response.Item);
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

app.post('/npc-interaction', async (req, res) => {
    try {
     const { action } = req.body;

     console.log('Attempting to invoke Bedrock with params:', {
      modelId: "anthropic.claude-v2",
      region: process.env.AWS_REGION || "us-east-1"
    });

     // Prepare the prompt for the model
     const prompt = `\n\nHuman: Generate a response for the action "${action}" in a fantasy RPG setting.\n\nAssistant:`;

     const params = {
        modelId: "anthropic.claude-v2", // or another model ID you prefer
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
        prompt: prompt,
        max_tokens_to_sample: 300,
        temperature: 0.7,
        top_p: 0.9,
        })
      };

    console.log('Invoking Bedrock with params:', JSON.stringify(params, null, 2));

    // Call Bedrock
    const command = new InvokeModelCommand(params);

    try {
    const response = await bedrockClient.send(command);
    console.log('Bedrock response received');

    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    res.status(200).json({
      message: responseBody.completion || responseBody.text
    });
  }
  catch (bedrockError) {
    console.error('Bedrock Error:', {
      error: bedrockError,
      errorMessage: bedrockError.message,
      errorStack: bedrockError.stack,
      errorType: bedrockError.$metadata
    });
    throw bedrockError;
  }
  } catch (error) {
  console.error('Error in NPC interaction:', error);
  res.status(500).json({ 
    error: 'Failed to process NPC interaction',
    details: error.message,
    type: error.$metadata?.httpStatusCode ? 'Bedrock Error' : 'General Error'
  });
}
});
 
// Create Lambda handler
const server = serverless.createServer(app);
exports.handler = (event, context) => {
  serverless.proxy(server, event, context);
};
