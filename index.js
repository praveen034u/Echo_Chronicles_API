const express = require('express');
const serverless = require('aws-serverless-express');
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { body, validationResult } = require('express-validator');
const cors = require('cors');
const AWS = require('aws-sdk');
const { createNoise2D } = require('simplex-noise');
const noise2D = createNoise2D();

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

// Function to generate terrain
function generateTerrain(width, height) {
    const terrain = [];
    const scale = 50; // previous value was 50 Adjust this value to change the "zoom level" of the terrain
        
       for (let x = 0; x < width; x++) {
        terrain[x] = [];
        for (let y = 0; y < height; y++) {
            const elevation = noise2D(x / scale, y / scale); // Adjusted scale for better variation

            terrain[x][y] = elevation; // Store elevation (-1 to 1)
        }
    
  }
  return terrain;
    // for (let y = 0; y < height; y++) {
    //     terrain[y] = [];
    //     for (let x = 0; x < width; x++) {
    //         // Using the new noise2D function
    //         const value = noise2D(x / scale, y / scale);
    //         // Normalize the value from [-1, 1] to [0, 1]
    //         terrain[y][x] = (value + 1) / 2;
    //     }
    // }
}

// Save terrain to DynamoDB
async function saveTerrainToDynamoDB(playerId, playerX, playerY , terrain) {
 
  const command = new PutCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Item: {
          PlayerID: playerId,
          PlayerX: playerX,
          PlayerY: playerY,
          WorldMap: terrain,
          Timestamp: new Date().toISOString(),
    }
  });

  try {
      const response = await docClient.send(command);
      console.log(`Terrain saved for PlayerID: ${playerId}`);
      return response;
  } catch (error) {
      console.error('Error saving to DynamoDB:', error);
      throw new Error('Failed to save terrain data');
  }
}

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

    const response = await docClient.send(command);
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
     const { playeraction } = req.body;

     console.log('Attempting to invoke Bedrock with params:', {
      modelId: "anthropic.claude-v2",
      region: process.env.AWS_REGION || "us-east-1"
    });

     // Prepare the prompt for the model
     const prompt = `\n\nHuman: Generate a response for the action "${playeraction}" in a fantasy RPG setting.\n\nAssistant:`;

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

// Save score endpoint
app.post('/generateTerrain', async (req, res) => {

   try {
        // Parse input from event body
        const { 
          playerId = `player1`, 
          playerX=0,
          playerY=0,
          width = 50, // previous value was 100
          height =  50 // previous value was 100 
         } = req.body;

        // Generate terrain
        const terrain = generateTerrain(width, height);

        // Convert terrain into map format for exploration
        const worldMap = terrain.map((row, x) => row.map((tile, y) => ({
          type: tile < -0.2 ? 'water' : tile > 0.5 ? 'mountain' : 'grass',
          discovered: false,
          isLandmark: false, // Ensure landmarks are not randomly applied to all tiles
        })));

       // Mark specific landmarks
       markLandmarks(worldMap);

        // Save to DynamoDB
        await saveTerrainToDynamoDB(playerId, playerX, playerY, worldMap);

       // Return response
       res.status(200).json({
        message: playerId || playerX || playerY || width || height ? 'Terrain generated and saved successfully' : 'Terrain generated successfully',
        playerX:playerX,
        playerY:playerY,
        terrain: worldMap
      });
    } catch (error) {
        console.error('Error generating terrain:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to generate terrain' }),
        };
    }
});

// Mark landmarks explicitly to avoid all tiles being treated as landmarks
function markLandmarks(worldMap) {
  const height = worldMap.length;
  const width = worldMap[0].length;

  // Example: Mark a few key locations as landmarks
  worldMap[0][0].isLandmark = true; // Top-left corner
  worldMap[Math.floor(height / 2)][Math.floor(width / 2)].isLandmark = true; // Center
  worldMap[height - 1][width - 1].isLandmark = true; // Bottom-right corner
};
 
// Create Lambda handler
const server = serverless.createServer(app);
exports.handler = (event, context) => {
  serverless.proxy(server, event, context);
};
