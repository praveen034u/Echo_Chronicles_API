const express = require('express');
const serverless = require('aws-serverless-express');
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
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

// Function to generate terrain with features and landmarks
function generateTerrainByAI(width, height, landmarkPercentage = 0.05) {
    const terrain = [];
    const totalLandmarks = Math.floor(width * height * landmarkPercentage);
    let landmarksCount = 0;
    const scale = 50; // previous value was 50 Adjust this value to change the "zoom level" of the terrain
        
       for (let x = 0; x < width; x++) {
        terrain[x] = [];
        for (let y = 0; y < height; y++) {
            const elevation = noise2D(x / scale, y / scale); // Adjusted scale for better variation
            let type;
             // Assign terrain type based on elevation thresholds
             if (elevation < -0.2) {
               type = 'water';
                } else if (elevation > 0.5) {
               type = 'mountain';
                } else {
              type = 'grass';
              }

           // Initialize the tile
           const tile = {
            type: type,         // Terrain type
            discovered: false,  // Fog of war
            isLandmark: false,  // Default to no landmark
            landmarkType: null, // Type of landmark (e.g., cave, village, etc.)
            hasQuest: false,    // Quest flag
            hasMerchant: false, // Merchant flag
            quest: null         // Quest details (if any)
        };

         // Randomly assign landmarks
         if (landmarksCount < totalLandmarks && Math.random() < landmarkPercentage) {
          tile.isLandmark = true;
          tile.landmarkType = assignLandmarkType(tile.type); // Assign landmark type based on terrain
          landmarksCount++;
          }

          terrain[x][y] = tile;
       }
     }
    
     // Ensure key landmarks are always placed (e.g., corners, center)
    enforceKeyLandmarks(terrain, width, height);

    return terrain;
}
 
// Function to assign landmark types based on terrain
function assignLandmarkType(terrainType) {
  switch (terrainType) {
      case 'mountain':
          return 'cave';
      case 'grass':
          return 'village';
      case 'water':
          return 'sunken treasure';
      default:
          return 'unknown';
  }
}

// Function to enforce key landmarks in specific locations
function enforceKeyLandmarks(terrain, width, height) {
  // Example: Mark specific positions as landmarks
  terrain[0][0].isLandmark = true; // Top-left corner
  terrain[0][0].landmarkType = 'village';

  terrain[Math.floor(height / 2)][Math.floor(width / 2)].isLandmark = true; // Center
  terrain[Math.floor(height / 2)][Math.floor(width / 2)].landmarkType = 'cave';

  terrain[height - 1][width - 1].isLandmark = true; // Bottom-right corner
  terrain[height - 1][width - 1].landmarkType = 'sunken treasure';
}

// Save terrain to DynamoDB
async function saveTerrainToDynamoDB(playerId, player, sessionId, terrain) {
 
  // Ensure the data is in a DynamoDB-compatible format
  const sanitizedPlayer = JSON.parse(JSON.stringify(player));
  const sanitizedTerrain = JSON.parse(JSON.stringify(terrain));

  const command = new PutCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Item: {
          SessionID: sessionId,
          PlayerID: playerId,
          PlayerData: sanitizedPlayer,
          WorldMap: sanitizedTerrain,
          Timestamp: new Date().toISOString(),
    }
  });

  try {
      const response = await docClient.send(command);
      console.log(`Terrain saved for PlayerID: ${playerId} and sessionID: ${sessionId}`);
      return response;
  } catch (error) {
      console.error('Error saving to DynamoDB:', error);
      throw new Error('Failed to save terrain data');
  }
}

// geenrtate terrain config
async function generateTerrainConfigByAI(imaginaryWorld, prompt) {
  if(prompt == null)
  {
  const predefinedPrompts = {
    Fantasy: "Generate a structured JSON for a fantasy terrain map:- Map size: 20x20 - Grass: 40% - Forest: 30% - Mountain: 20% - Water: 10% Include:- 3 villages spread across the grasslands and forests.- 2 hidden dungeons located in the mountains.- 1 ancient ruin near a water body.- Ensure landmarks are evenly distributed across the map.",
    SciFi: "Generate a structured JSON for a sci-fi terrain map:- Map size: 20x20- Cratered Landscapes: 40%- Alien Flora: 30%- Rocky Terrain: 20%- Water Reservoirs: 10%Include:- advanced alien structures (e.g., research facilities or ruins).- 2 crash sites for alien spaceships.- 1 hidden energy core in a rocky area.Ensure landmarks align with a futuristic, alien aesthetic.",
    PostApocalyptic: "Generate a structured JSON for a post-apocalyptic terrain map:- Map size: 20x20- Desert: 50%- Ruins: 20%- Scrublands: 20%- Water: 10%Include:- 2 scattered oases located near water sources.- 1 ruined city in the middle of the map.- 3 supply caches located in the ruins and scrublands.Ensure a feeling of scarcity and survival.",
  };

   prompt = predefinedPrompts[imaginaryWorld] || "Generate a structured JSON for a fantasy terrain map:- Map size: 20x20 - Grass: 40% - Forest: 30% - Mountain: 20% - Water: 10% Include:- 3 villages spread across the grasslands and forests.- 2 hidden dungeons located in the mountains.- 1 ancient ruin near a water body.- Ensure landmarks are evenly distributed across the map.";
  }

  let jsonData = null;
  prompt = `\n\nHuman: ${prompt}\n\nAssistant:`;
  try {
    console.log('Attempting to invoke Bedrock with params:', {
     modelId: "anthropic.claude-v2",
     region: process.env.AWS_REGION || "us-east-1"
   });

    // Prepare the prompt for the model
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
     const response = await bedrockClient.send(command);
     console.log('Bedrock response received');
      if(response.body)
      {
       // Parse the response
       const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
       // For Claude model, the response is in the completion property
       const messageText = responseBody.completion || responseBody.text || '';
 
       const jsonBlockPatterns = [
        /```json\n([\s\S]*?)\n```/, // Standard JSON block
        /```\n([\s\S]*?)\n```/,     // Generic code block
        /{[\s\S]*}/                 // Just find JSON object
    ];

    
    for (const pattern of jsonBlockPatterns) {
        const match = messageText.match(pattern);
        if (match && match[1]) {
            try {
                jsonData = JSON.parse(match[1].trim());
                console.log('Successfully parsed JSON using pattern:', pattern);
                break;
            } catch (e) {
                console.log(`Failed to parse with pattern ${pattern}:`, e.message);
                continue;
            }
        }
    }

    if (!jsonData) {
        // If no JSON found, try to extract the entire response
        const possibleJson = messageText.trim();
        try {
            jsonData = JSON.parse(possibleJson);
        } catch (e) {
            throw new Error('Could not find valid JSON in response');
        }
    }
    else
    {
        console.error(`'Failed to process Bedrock json response, instead of error, just send the static terrain config response based on request type`);
        throw new Error('Failed to process Bedrock json response');
      }
    
  }
  else {
    console.error('Response body is empty or undefined', {
      error: error.message
    });
    throw new Error('Failed to process Bedrock response');
  }
 } catch (error) {
 console.error('Error in encountered while fetching date from bedrock AI model:', {
  error: error.message
 });
}
finally {
  if(jsonData == null || jsonData.message == null || Object.keys(jsonData.message).length === 0)
  {
//default cached version of terrain config previously generated by bedrock AI
jsonData = {
  "message": {
        "mapSize": [
            20,
            20
        ],
  "terrain": {
      "crateredLandscape": {
          "coverage": 40,
          "features": []
      },
      "alienFlora": {
          "coverage": 30,
          "features": []
      },
      "rockyTerrain": {
          "coverage": 20,
          "features": []
      },
      "waterReservoirs": {
          "coverage": 10,
          "features": []
      }
  },
  "landmarks": {
      "advancedAlienStructures": [
          {
              "type": "researchFacility",
              "location": [5, 8]
          },
          {
              "type": "alienRuins",
              "location": [15, 3]
          }
      ],
      "crashSites": [
          {
              "location": [10, 12]
          },
          {
              "location": [3, 17]
          }
      ],
      "hiddenEnergyCore": {
          "location": [14, 5]
      }
   }
  }
   };
  }
}
return jsonData;
}

// Get user get saved terrain from previous sessions
app.post('/getSavedTerrain', async (req, res) => {
  try {

    const { sessionId, playerId} = req.body;
    const params = {
      TableName: process.env.DYNAMODB_TABLE,
      KeyConditionExpression: "SessionId = :sessionId",
      FilterExpression: "PlayerId = :playerId",
      ExpressionAttributeValues: {
        ":sessionId": sessionId, // Replace with actual value
        ":playerId": playerId // Replace with actual value
      },
    };
  
      const command = new QueryCommand(params);
      const response = await client.send(command);

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

app.post('/generateTerrain', async (req, res) => {

  const { 
    player: {
      name = `player123`, 
      activeQuests = [],
      inventory = [],
      position = { x: 0, y: 0 },
      experience = 0,
      gold = 0
    },
    sessionId = 0,
    width = 50, // previous value was 100
    height =  50, // previous value was 100 
    landmarkPercentage = 0.05,
    imaginaryWorld = 'Fantasy',
    prompt = null
   } = req.body;
   
    // Read terrain configuration from Bedrock AI
    const terrainConfig = await generateTerrainConfigByAI(imaginaryWorld, prompt); 
       
    // Generate terrain
    const terrain = await generateDynamicTerrain(width, height, terrainConfig.message, landmarkPercentage)

    // Save to DynamoDB
    const player = req.body.player;
    await saveTerrainToDynamoDB(player.name, player, sessionId, terrain);

   // Return response
   res.status(200).json({
    message: player.name || width || height ? 'Terrain generated and saved successfully' : 'Terrain generated successfully',
    terrain: terrain
  });

});

// Generate Terrain Based on Terrain Configuration from Bedrock
async function generateDynamicTerrain(width, height, terrainConfig) {
  const terrain = Array.from({ length: height }, () => Array.from({ length: width }, () => null));
  const terrainTypes = Object.keys(terrainConfig.terrain); // ['grass', 'forest', 'mountain', 'water']

  // Calculate total tiles and distribution of terrain types
  const totalTiles = width * height;
  const typeCounts = terrainTypes.reduce((counts, type) => {
      counts[type] = Math.floor((terrainConfig.terrain[type] / 100) * totalTiles);
      return counts;
  }, {});

  // Generate terrain grid using noise for hybrid approach
  for (let x = 0; x < height; x++) {
    for (let y = 0; y < width; y++) {
        const elevation = noise2D(x / 50, y / 50); // Generate elevation using noise
        let type;

        // Map elevation to terrain type
        if (elevation < -0.2) {
            type = 'water';
        } else if (elevation > 0.5) {
            type = 'mountain';
        } else {
            type = await getRandomTerrainType(typeCounts);
        }

        terrain[x][y] = { type, isLandmark: false, landmarkType: null, discovered: false, hasMerchant: false, hasQuest: false,quest: null };
    }
}

  // Place merchants randomly on a subset of tiles
  await assignMerchantsToRandomTiles(terrain, Math.floor(totalTiles * 0.05)); // 5% of tiles have merchants

  // Place landmarks
  await processLandmarks(terrain, terrainConfig.landmarks);
  
  //assign quest based on multiple criteria
  await assignQuestsToTiles(terrain);
  return terrain;
}

// Assign merchants to random tiles
async function assignMerchantsToRandomTiles(terrain, merchantCount) {
  const height = terrain.length;
  const width = terrain[0].length;
  let assigned = 0;

  while (assigned < merchantCount) {
      const x = Math.floor(Math.random() * height);
      const y = Math.floor(Math.random() * width);

      if (!terrain[x][y].hasMerchant && terrain[x][y].type !== 'water') { // Avoid water tiles
          terrain[x][y].hasMerchant = true;
          assigned++;
      }
  }
}

// Process landmarks from Bedrock AI's terrain configuration
async function processLandmarks(terrain, landmarks) {
  // Handle advancedAlienStructures
  if (Array.isArray(landmarks.advancedAlienStructures)) {
      landmarks.advancedAlienStructures.forEach((structure) => {
          const [x, y] = structure.location;
          if (terrain[x] && terrain[x][y]) {
              terrain[x][y].isLandmark = true;
              terrain[x][y].landmarkType = structure.type || 'unknown structure';
          }
      });
  }

  // Handle crashSites
  if (Array.isArray(landmarks.crashSites)) {
      landmarks.crashSites.forEach((site) => {
          const [x, y] = site.location;
          if (terrain[x] && terrain[x][y]) {
              terrain[x][y].isLandmark = true;
              terrain[x][y].landmarkType = 'crash site';
          }
      });
  }

  // Handle hiddenEnergyCore
  if (landmarks.hiddenEnergyCore && landmarks.hiddenEnergyCore.location) {
      const [x, y] = landmarks.hiddenEnergyCore.location;
      if (terrain[x] && terrain[x][y]) {
          terrain[x][y].isLandmark = true;
          terrain[x][y].landmarkType = 'hidden energy core';
      }
  }
}

// Helper function to randomly assign terrain types based on available counts
async function getRandomTerrainType(typeCounts) {
  const availableTypes = Object.keys(typeCounts).filter((type) => typeCounts[type] > 0);

  // Ensure grass is included if no other types are available
  if (availableTypes.length === 0) {
      typeCounts['grass'] = (typeCounts['grass'] || 0) + 1; // Add a default grass tile
      return 'grass';
  }

  const selectedType = availableTypes[Math.floor(Math.random() * availableTypes.length)];
  typeCounts[selectedType]--;
  return selectedType;
}




// Tile-Based Quest Assignment with Multiple Criteria
async function assignQuestsToTiles(worldMap) {
  const quests = [];

  for (const [x, row] of worldMap.entries()) {
    for (const [y, tile] of row.entries()) {
      // Assign quests based on specific criteria
     
      let calcX = x;
      if (calcX <= 0) {
        calcX += 25;
      }else if (calcX >= 49) {
        calcX -= 25;
      }
      let calcY= y;
      if (calcY <= 0) {
        calcY += 25;
      }else if (calcY >= 49) {
        calcY -= 25;
      }
      
      // Criterion 1: If the tile has a merchant
      if (tile.hasMerchant) {
        const quest = {
          description: `Help the merchant at (${calcX}, ${calcY}) deliver goods to a nearby village.`,
          location: { calcX, calcY },
          type: 'delivery',
          rewards: { experience: 100, gold: 50 },
        };
        tile.quest = quest; // Bind quest to the tile
        tile.hasQuest = true; // Mark tile as having a quest
        quests.push(quest);
      }

      // Criterion 2: If the tile is a cave landmark
      else if (tile.isLandmark && tile.landmarkType === 'cave') {
        const quest = {
          description: `Explore the cave at (${calcX}, ${calcY}) and retrieve the hidden treasure.`,
          location: { calcX, calcY },
          type: 'exploration',
          rewards: { experience: 150, items: ['Rare Gem'] },
        };
        tile.quest = quest; // Bind quest to the tile
        tile.hasQuest = true; // Mark tile as having a quest
        quests.push(quest);
      }

      // Criterion 3: Randomly assign quests to forest tiles
      else if (tile.type === 'forest' && Math.random() < 0.1) { // 10% chance
        const quest = {
          description: `Collect medicinal herbs from the forest at (${calcX}, ${calcY}).`,
          location: { calcX, calcY },
          type: 'gathering',
          rewards: { experience: 75, items: ['Healing Potion'] },
        };
        tile.quest = quest; // Bind quest to the tile
        tile.hasQuest = true; // Mark tile as having a quest
        quests.push(quest);
      }

      // Criterion 4: If the tile is near water and not a landmark
      else if (tile.type === 'grass' && isNearWater(worldMap, x, y)) {
        const quest = {
          description: `Search the area at (${calcX}, ${calcY}) for lost fishing equipment.`,
          location: { calcX, calcY },
          type: 'search',
          rewards: { experience: 50, items: ['Fishing Rod'] },
        };
        tile.quest = quest; // Bind quest to the tile
        tile.hasQuest = true; // Mark tile as having a quest
        quests.push(quest);
      }
    }
  }

  return quests;
}

// Helper function to check if a tile is near water
function isNearWater(worldMap, x, y) {
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1], // Cardinal directions
    [-1, -1], [-1, 1], [1, -1], [1, 1], // Diagonal directions
];

for (const [dx, dy] of directions) {
    const nx = x + dx;
    const ny = y + dy;
    if (worldMap[nx] && worldMap[nx][ny] && worldMap[nx][ny].type === 'water') {
        return true;
    }
}

return false;
}

//generate save Terrain
app.post('/saveTerrain', async (req, res) => {

   try {
    const { 
      player: {
        name = `player123`, 
        activeQuests = [],
        inventory = [],
        position = { x: 0, y: 0 },
        experience = 0,
        gold = 0
      },
      sessionId = 0,
      terrain
     } = req.body;
  
      // Save to DynamoDB
      const player = req.body.player;
      
      await saveTerrainToDynamoDB(player.name, player, sessionId, terrain);

       // Return response
       res.status(200).json({
        message: player.name ? player.name+'- User Terrain data saved successfully' : 'Terrain generated successfully',
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
