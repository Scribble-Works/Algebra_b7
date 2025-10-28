// Import necessary modules
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Server-Side Game State ---
let activePlayers = {}; // Stores player objects: { id, name, score, totalTimeMs, questionIndex, questionSet, timer, status }
const MAX_QUESTIONS = 10;
const TIME_PER_QUESTION_SECONDS = 60;
const PORT = process.env.PORT || 3000;

// --- Utility Functions ---

/**
 * Generates a set of 10 unique, simple linear equations.
 */
function generateQuestionSet() {
    const questions = [];
    for (let i = 0; i < MAX_QUESTIONS; i++) {
        const uniqueId = Date.now() + i;
        const A = Math.floor(Math.random() * 5) + 1; 
        const B = Math.floor(Math.random() * 10) + 1; 
        const X = Math.floor(Math.random() * 10) + 1; 
        const C = A * X + B;

        let text;
        if (A === 1) {
            text = `X + ${B} = ${C}`;
        } else {
            text = `${A}X + ${B} = ${C}`;
        }

        questions.push({
            id: uniqueId,
            text: text,
            answer: X,
            points: 10
        });
    }
    return questions;
}

/**
 * Converts milliseconds to a display format (MM:SS.ms).
 */
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = ms % 1000;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().slice(0, 2).padStart(2, '0')}`;
}

/**
 * Starts a 60-second timer for a specific player's current question.
 */
function startQuestionTimer(playerId) {
    const player = activePlayers[playerId];
    if (!player || player.status === 'finished') return;

    if (player.timer) {
        clearInterval(player.timer);
    }

    const socket = io.sockets.sockets.get(playerId);
    if (!socket) return;
    
    player.currentQuestionStartTime = Date.now();
    let timeLeft = TIME_PER_QUESTION_SECONDS;

    socket.emit('updateTimer', timeLeft);
    
    player.timer = setInterval(() => {
        timeLeft--;
        socket.emit('updateTimer', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(player.timer);
            player.timer = null;
            
            const currentQ = player.questionSet[player.questionIndex];
            socket.emit('answerFeedback', { 
                isCorrect: false, 
                reason: 'Time up!', 
                correctAnswer: currentQ.answer 
            });

            setTimeout(() => {
                moveToNextQuestion(playerId);
            }, 2000); 
        }
    }, 1000); 
}

/**
 * Advances the player to the next question or ends the game.
 */
function moveToNextQuestion(playerId) {
    const player = activePlayers[playerId];
    if (!player) return;

    if (player.timer) {
        clearInterval(player.timer);
        player.timer = null;
    }

    player.questionIndex++;

    if (player.questionIndex < MAX_QUESTIONS) {
        const nextQuestion = player.questionSet[player.questionIndex];
        io.to(playerId).emit('newQuestion', {
            ...nextQuestion,
            index: player.questionIndex + 1,
            total: MAX_QUESTIONS
        });
        startQuestionTimer(playerId);
        broadcastLeaderboard(); 
    } else {
        // Game Over!
        player.status = 'finished';
        player.totalTimeMs = Date.now() - player.gameStartTime;
        io.to(playerId).emit('gameOver', {
            score: player.score,
            totalTime: formatTime(player.totalTimeMs)
        });
        broadcastLeaderboard(); 
        checkAndNotifyWinners();
    }
}

/**
 * Checks for finished players, ranks them, and broadcasts the top 3 (or fewer) to all clients.
 */
function checkAndNotifyWinners() {
    const finishedPlayers = Object.values(activePlayers)
        .filter(p => p.status === 'finished')
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return a.totalTimeMs - b.totalTimeMs;
        })
        .slice(0, 3) 
        .map(p => ({
            name: p.name,
            score: p.score,
            time: formatTime(p.totalTimeMs)
        }));

    if (finishedPlayers.length > 0) {
        io.emit('winnerNotification', finishedPlayers);
    }
}


/**
 * Sorts players by two criteria: 1. Score (desc), 2. Time (asc) 
 * and updates all clients.
 */
function broadcastLeaderboard() {
    const playersArray = Object.values(activePlayers);

    const sortedPlayers = playersArray
        .sort((a, b) => {
            if (a.status === 'finished' && b.status !== 'finished') return -1;
            if (a.status !== 'finished' && b.status === 'finished') return 1;

            if (a.status === 'finished' && b.status === 'finished') {
                if (b.score !== a.score) {
                    return b.score - a.score; 
                }
                return a.totalTimeMs - b.totalTimeMs; 
            }

            return b.score - a.score;
        })
        .map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            status: p.status === 'finished' ? `Finished (${formatTime(p.totalTimeMs)})` : `Q${p.questionIndex + 1}/${MAX_QUESTIONS}`,
            totalTimeMs: p.status === 'finished' ? p.totalTimeMs : Infinity
        }));

    io.emit('updateLeaderboard', sortedPlayers);
    io.emit('playerCount', sortedPlayers.length);
}

// --- Express Configuration ---
app.use(express.static('public')); 

// --- Socket.IO Connection Handlers ---

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    broadcastLeaderboard(); 

    // --- Player Join ---
    socket.on('joinGame', (playerName) => {
        // ... (Join logic unchanged)
        const newQuestionSet = generateQuestionSet();
        const firstQuestion = newQuestionSet[0];

        activePlayers[socket.id] = {
            id: socket.id,
            name: playerName || `Player ${Math.floor(Math.random() * 1000)}`,
            score: 0,
            questionIndex: 0,
            questionSet: newQuestionSet,
            gameStartTime: Date.now(),
            totalTimeMs: 0,
            timer: null,
            status: 'in-progress'
        };

        console.log(`Player joined: ${activePlayers[socket.id].name}`);

        socket.emit('newQuestion', {
            ...firstQuestion,
            index: 1,
            total: MAX_QUESTIONS
        });
        
        startQuestionTimer(socket.id);
        broadcastLeaderboard();
        checkAndNotifyWinners();
    });

    // --- Answer Submission: The Reinforced Block ---
    socket.on('submitAnswer', (data) => {
        const player = activePlayers[socket.id];
        if (!player || player.status === 'finished') {
             console.log(`[Error] Player ${socket.id} not found or finished.`);
             return;
        }

        try {
            const currentQ = player.questionSet[player.questionIndex];
            
            // CRITICAL: Ensure we are comparing the answer as an integer to an integer
            const submittedAnswerInt = parseInt(data.answer, 10);
            
            // Check for valid number conversion
            if (isNaN(submittedAnswerInt)) {
                console.log(`[Validation Error] Answer submitted was not a number: ${data.answer}`);
                socket.emit('answerFeedback', { isCorrect: false, reason: 'Invalid Input.', correctAnswer: currentQ.answer });
                setTimeout(() => moveToNextQuestion(socket.id), 2000);
                return;
            }

            const isCorrect = 
                data.questionId === currentQ.id && 
                submittedAnswerInt === currentQ.answer;

            console.log(`[Answer] Player: ${player.name}, Q: ${currentQ.text}, Submitted: ${submittedAnswerInt}, Correct: ${currentQ.answer}, Result: ${isCorrect ? 'Correct' : 'Incorrect'}`);

            // Stop the current timer immediately
            if (player.timer) {
                 clearInterval(player.timer);
                 player.timer = null;
            }

            if (isCorrect) {
                player.score += currentQ.points;
                socket.emit('answerFeedback', { isCorrect: true, correctAnswer: currentQ.answer });
                // Schedule the next question
                setTimeout(() => moveToNextQuestion(socket.id), 1000); 
                
            } else {
                socket.emit('answerFeedback', { 
                    isCorrect: false, 
                    reason: 'Incorrect.', 
                    correctAnswer: currentQ.answer 
                });
                // Schedule the next question
                setTimeout(() => moveToNextQuestion(socket.id), 2000);
            }
        } catch (error) {
            console.error(`[CRITICAL ERROR] Failed during submitAnswer for player ${player.name}:`, error.message);
            // Attempt to recover by manually advancing the player
            socket.emit('answerFeedback', { isCorrect: false, reason: 'Server Error.', correctAnswer: player.questionSet[player.questionIndex]?.answer });
            setTimeout(() => moveToNextQuestion(socket.id), 3000);
        }
    });

    // --- Player Disconnect ---
    socket.on('disconnect', () => {
        const player = activePlayers[socket.id];
        if (player && player.timer) {
            clearInterval(player.timer);
        }
        
        console.log(`User disconnected: ${socket.id}`);
        delete activePlayers[socket.id];
        broadcastLeaderboard();
        checkAndNotifyWinners();
    });
});

// --- 4. Start the Server ---
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
