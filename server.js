const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const CANVAS_W = 800;
const CANVAS_H = 550;
const MIN_SECTOR = -2;
const MAX_SECTOR = 2;

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return rooms[code] ? generateRoomCode() : code;
}

function getSectorKey(sx, sy) {
    return `${sx},${sy}`;
}

function spawnTreesInSector(room, sx, sy, count) {
    const data = room.worldSectors[getSectorKey(sx, sy)];
    const isHome = (sx === 0 && sy === 0);
    for (let i = 0; i < count; i++) {
        let tx = Math.random() * (CANVAS_W - 90) + 45;
        let ty = Math.random() * (CANVAS_H - 90) + 55;
        let tooClose = isHome && Math.hypot(tx - 400, ty - 275) < 145;
        data.trees.forEach(t => {
            if (Math.hypot(tx - t.x, ty - t.y) < 52) tooClose = true;
        });
        if (!tooClose) {
            data.trees.push({
                id: Math.random().toString(36).substr(2, 9),
                x: tx, y: ty, hp: 3, shake: 0, radius: 22
            });
        }
    }
}

function getSectorData(room, sx, sy) {
    const key = getSectorKey(sx, sy);
    if (!room.worldSectors[key]) {
        room.worldSectors[key] = {
            trees: [],
            fences: [],
            torches: [],
            wolves: [],
            lostSheep: []
        };
        const isHome = (sx === 0 && sy === 0);
        const dist = Math.max(Math.abs(sx), Math.abs(sy));
        const treeCount = isHome ? 8 : (dist === 2 ? 22 : 17);
        spawnTreesInSector(room, sx, sy, treeCount);
    }
    return room.worldSectors[key];
}

function countWorldLostSheep(room) {
    let total = 0;
    Object.values(room.players).forEach(p => {
        total += p.followingSheep.length;
    });
    for (let sx = MIN_SECTOR; sx <= MAX_SECTOR; sx++) {
        for (let sy = MIN_SECTOR; sy <= MAX_SECTOR; sy++) {
            total += getSectorData(room, sx, sy).lostSheep.length;
        }
    }
    return total;
}

function spawnLostSheepRandomly(room, targetTotal = 3) {
    let currentTotal = countWorldLostSheep(room);
    let attempts = 0;

    while (currentTotal < targetTotal && attempts < 40) {
        attempts++;
        const sx = Math.floor(Math.random() * 5) - 2;
        const sy = Math.floor(Math.random() * 5) - 2;
        if (sx === 0 && sy === 0) continue;

        const sec = getSectorData(room, sx, sy);
        if (sec.lostSheep.length > 0) continue;

        sec.lostSheep.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * (CANVAS_W - 180) + 90,
            y: Math.random() * (CANVAS_H - 180) + 90,
            vx: 0, vy: 0,
            facing: Math.random() > 0.5 ? 1 : -1,
            radius: 16
        });
        currentTotal++;
    }
}

function spawnWolfInSector(room, sx, sy) {
    if (!room.isNight || !room.gameRunning) return;
    const sec = getSectorData(room, sx, sy);
    let side = Math.floor(Math.random() * 4);
    let wx, wy;
    if (side === 0) { wx = Math.random() * CANVAS_W; wy = -20; }
    else if (side === 1) { wx = CANVAS_W + 20; wy = Math.random() * CANVAS_H; }
    else if (side === 2) { wx = Math.random() * CANVAS_W; wy = CANVAS_H + 20; }
    else { wx = -20; wy = Math.random() * CANVAS_H; }

    sec.wolves.push({
        id: Math.random().toString(36).substr(2, 9),
        x: wx, y: wy,
        baseSpeed: 1.15,
        blinded: false,
        attackCooldown: 0,
        facing: wx > 400 ? -1 : 1,
        radius: 15
    });
}

function createRoom(code) {
    const room = {
        code,
        day: 1,
        isNight: false,
        phaseTimer: 30,
        totalSecondsSurvived: 0,
        wood: 15, // קצת יותר עצים התחלתיים לשני שחקנים
        rescuedCount: 0,
        gameRunning: true,
        gameOverReason: "",
        frameCount: 0,
        worldSectors: {},
        sheep: [],
        players: {},
        pendingTimeouts: []
    };

    for (let sx = MIN_SECTOR; sx <= MAX_SECTOR; sx++) {
        for (let sy = MIN_SECTOR; sy <= MAX_SECTOR; sy++) {
            getSectorData(room, sx, sy);
        }
    }

    for (let i = 0; i < 5; i++) {
        room.sheep.push({
            id: i,
            x: 370 + Math.random() * 60,
            y: 250 + Math.random() * 50,
            vx: 0, vy: 0,
            facing: Math.random() > 0.5 ? 1 : -1,
            radius: 16
        });
    }

    spawnLostSheepRandomly(room, 3);
    rooms[code] = room;
    return room;
}

function createPlayerObj(id, index, name) {
    const colors = ['#2980b9', '#e74c3c', '#8e44ad', '#d35400'];
    return {
        id,
        name: name || `רועה ${index + 1}`,
        color: colors[index % colors.length],
        x: 380 + index * 40,
        y: 275,
        sector: { x: 0, y: 0 },
        speed: 3.4,
        radius: 14,
        hp: 100,
        maxHp: 100,
        hurtTimer: 0,
        swordUses: 0,
        swingTimer: 0,
        swingAngle: 0,
        facing: 1,
        isMoving: false,
        aimAngle: 0,
        keys: {},
        followingSheep: []
    };
}

function emitSoundToSector(room, sx, sy, soundName) {
    Object.values(room.players).forEach(p => {
        if (p.sector.x === sx && p.sector.y === sy) {
            io.to(p.id).emit('sound', soundName);
        }
    });
}

function updateRoomLogic(room) {
    if (!room.gameRunning) return;
    room.frameCount++;

    const playerList = Object.values(room.players);
    if (playerList.length === 0) return;

    // 1. עדכון שחקנים
    playerList.forEach(p => {
        if (p.hurtTimer > 0) p.hurtTimer--;
        if (p.swingTimer > 0) p.swingTimer--;

        // אם השחקן פצוע (0 חיים), הוא מחכה להחייאה או לבוקר
        if (p.hp <= 0) {
            p.isMoving = false;
            // בדיקה אם שחקן חי קרוב אליו כדי להרים אותו!
            playerList.forEach(other => {
                if (other.id !== p.id && other.hp > 0 && other.sector.x === p.sector.x && other.sector.y === p.sector.y) {
                    if (Math.hypot(other.x - p.x, other.y - p.y) < 42) {
                        p.hp = 50;
                        io.to(room.code).emit('sound', 'rescue');
                    }
                }
            });
            return;
        }

        let dx = 0, dy = 0;
        if (p.keys.up) dy -= 1;
        if (p.keys.down) dy += 1;
        if (p.keys.left) dx -= 1;
        if (p.keys.right) dx += 1;

        p.isMoving = (dx !== 0 || dy !== 0);

        if (p.isMoving) {
            let len = Math.hypot(dx, dy);
            p.x += (dx / len) * p.speed;
            p.y += (dy / len) * p.speed;
            if (dx !== 0) p.facing = dx > 0 ? 1 : -1;

            let changedSector = false;
            if (p.x < 5) {
                if (p.sector.x > MIN_SECTOR) { p.sector.x--; p.x = CANVAS_W - 15; changedSector = true; }
                else p.x = 5;
            } else if (p.x > CANVAS_W - 5) {
                if (p.sector.x < MAX_SECTOR) { p.sector.x++; p.x = 15; changedSector = true; }
                else p.x = CANVAS_W - 5;
            }

            if (p.y < 5) {
                if (p.sector.y > MIN_SECTOR) { p.sector.y--; p.y = CANVAS_H - 15; changedSector = true; }
                else p.y = 5;
            } else if (p.y > CANVAS_H - 5) {
                if (p.sector.y < MAX_SECTOR) { p.sector.y++; p.y = 15; changedSector = true; }
                else p.y = CANVAS_H - 5;
            }

            if (changedSector) {
                const newSec = getSectorData(room, p.sector.x, p.sector.y);
                if (newSec.lostSheep.length > 0) {
                    io.to(p.id).emit('sound', 'sheepSoft');
                }
                if (p.followingSheep.length > 0) {
                    if (p.sector.x === 0 && p.sector.y === 0) {
                        while (p.followingSheep.length > 0) {
                            const rescued = p.followingSheep.pop();
                            rescued.x = 380 + Math.random() * 40;
                            rescued.y = 255 + Math.random() * 40;
                            rescued.vx = 0; rescued.vy = 0;
                            room.sheep.push(rescued);
                            room.rescuedCount++;
                        }
                        io.to(room.code).emit('sound', 'rescue');
                    } else {
                        p.followingSheep.forEach(fs => {
                            fs.x = p.x + (Math.random() - 0.5) * 24;
                            fs.y = p.y + (Math.random() - 0.5) * 24;
                            fs.vx = 0; fs.vy = 0;
                        });
                    }
                }
            }
        }

        // מפגש עם כבשים תועות בסקטור של השחקן
        const sec = getSectorData(room, p.sector.x, p.sector.y);
        for (let i = sec.lostSheep.length - 1; i >= 0; i--) {
            const ls = sec.lostSheep[i];
            if (Math.hypot(p.x - ls.x, p.y - ls.y) < 52) {
                sec.lostSheep.splice(i, 1);
                p.followingSheep.push(ls);
                io.to(p.id).emit('sound', 'sheepSoft');
            }
        }

        // תנועת כבשים שעוקבות אחרי השחקן
        p.followingSheep.forEach((fs, idx) => {
            const leader = idx === 0 ? p : p.followingSheep[idx - 1];
            const dist = Math.hypot(leader.x - fs.x, leader.y - fs.y);
            if (dist > 34) {
                const angle = Math.atan2(leader.y - fs.y, leader.x - fs.x);
                const followSpeed = Math.min(p.speed * 0.96, (dist - 28) * 0.14 + 1.2);
                fs.vx = Math.cos(angle) * followSpeed;
                fs.vy = Math.sin(angle) * followSpeed;
                fs.x += fs.vx;
                fs.y += fs.vy;
                if (Math.abs(fs.vx) > 0.05) fs.facing = fs.vx > 0 ? 1 : -1;
            } else {
                fs.vx = 0; fs.vy = 0;
            }
        });
    });

    // בדיקה אם כל השחקנים נפלו
    if (playerList.length > 0 && playerList.every(p => p.hp <= 0)) {
        room.gameRunning = false;
        room.gameOverReason = "כל הרועים הוכרעו על ידי הזאבים!";
        io.to(room.code).emit('sound', 'gameOver');
        return;
    }

    // 2. תנועת הכבשים בדיר ושיטוט כבשים תועות
    room.sheep.forEach(s => {
        if (Math.random() < 0.025) {
            s.vx = (Math.random() - 0.5) * 1.1;
            s.vy = (Math.random() - 0.5) * 1.1;
        }
        s.vx += (400 - s.x) * 0.0006;
        s.vy += (275 - s.y) * 0.0006;
        if (Math.abs(s.vx) > 0.05) s.facing = s.vx > 0 ? 1 : -1;
        s.x += s.vx;
        s.y += s.vy;
    });

    // 3. עדכון זאבים ועצים
    const speedMultiplier = 1 + (room.totalSecondsSurvived * 0.005);

    for (let sx = MIN_SECTOR; sx <= MAX_SECTOR; sx++) {
        for (let sy = MIN_SECTOR; sy <= MAX_SECTOR; sy++) {
            const sec = getSectorData(room, sx, sy);
            sec.trees.forEach(t => { if (t.shake > 0) t.shake--; });

            sec.lostSheep.forEach(ls => {
                if (Math.random() < 0.02) {
                    ls.vx = (Math.random() - 0.5) * 0.6;
                    ls.vy = (Math.random() - 0.5) * 0.6;
                }
                ls.x = Math.max(40, Math.min(CANVAS_W - 40, ls.x + ls.vx));
                ls.y = Math.max(40, Math.min(CANVAS_H - 40, ls.y + ls.vy));
                if (Math.abs(ls.vx) > 0.05) ls.facing = ls.vx > 0 ? 1 : -1;
            });

            const isHome = (sx === 0 && sy === 0);
            const playersInSector = playerList.filter(p => p.sector.x === sx && p.sector.y === sy && p.hp > 0);

            if (!isHome && playersInSector.length === 0) continue;

            for (let i = sec.wolves.length - 1; i >= 0; i--) {
                let w = sec.wolves[i];
                if (w.attackCooldown > 0) w.attackCooldown--;
                let currentWolfSpeed = (w.baseSpeed || 1.15) * speedMultiplier;

                // בדיקה אם פנס של אחד השחקנים בסקטור מסנוור את הזאב
                let blindedByPlayer = null;
                if (room.isNight) {
                    for (const p of playersInSector) {
                        let distToP = Math.hypot(w.x - p.x, w.y - p.y);
                        let angleToW = Math.atan2(w.y - p.y, w.x - p.x);
                        let angleDiff = Math.abs(p.aimAngle - angleToW);
                        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
                        if (distToP < 220 && angleDiff < 0.35) {
                            blindedByPlayer = { p, angleToW };
                            break;
                        }
                    }
                }

                w.blinded = !!blindedByPlayer;

                if (blindedByPlayer) {
                    let pushX = -Math.cos(blindedByPlayer.angleToW) * 2.1;
                    w.x += pushX;
                    w.y -= Math.sin(blindedByPlayer.angleToW) * 2.1;
                    if (Math.abs(pushX) > 0.05) w.facing = pushX > 0 ? 1 : -1;
                    w.x = Math.max(-35, Math.min(CANVAS_W + 35, w.x));
                    w.y = Math.max(-35, Math.min(CANVAS_H + 35, w.y));
                } else {
                    let target = null;
                    let targetType = null;
                    let targetOwner = null;
                    let minDist = Infinity;

                    playersInSector.forEach(p => {
                        let d = Math.hypot(p.x - w.x, p.y - w.y);
                        if (d < minDist) {
                            minDist = d;
                            target = p;
                            targetType = 'player';
                        }
                        p.followingSheep.forEach(fs => {
                            let fd = Math.hypot(fs.x - w.x, fs.y - w.y);
                            if (fd < minDist) {
                                minDist = fd;
                                target = fs;
                                targetType = 'followingSheep';
                                targetOwner = p;
                            }
                        });
                    });

                    if (isHome) {
                        if (room.sheep.length === 0) {
                            room.gameRunning = false;
                            room.gameOverReason = "העדר נטרף!";
                            io.to(room.code).emit('sound', 'gameOver');
                            return;
                        }
                        room.sheep.forEach(s => {
                            let d = Math.hypot(s.x - w.x, s.y - w.y);
                            if (d < minDist) {
                                minDist = d;
                                target = s;
                                targetType = 'sheep';
                            }
                        });
                    }

                    if (!target) continue;

                    let moveAngle = Math.atan2(target.y - w.y, target.x - w.x);
                    let stepX = Math.cos(moveAngle) * currentWolfSpeed;
                    let stepY = Math.sin(moveAngle) * currentWolfSpeed;
                    let nextX = w.x + stepX;
                    let nextY = w.y + stepY;
                    if (Math.abs(stepX) > 0.05) w.facing = stepX > 0 ? 1 : -1;

                    let hitFence = false;
                    for (let j = sec.fences.length - 1; j >= 0; j--) {
                        let f = sec.fences[j];
                        if (Math.hypot(nextX - f.x, nextY - f.y) < w.radius + f.radius) {
                            hitFence = true;
                            f.hp -= 0.5;
                            if (f.hp <= 0) {
                                sec.fences.splice(j, 1);
                                emitSoundToSector(room, sx, sy, 'chop');
                            }
                            break;
                        }
                    }

                    if (!hitFence) {
                        w.x = nextX;
                        w.y = nextY;
                    }

                    if (minDist < w.radius + target.radius) {
                        if (targetType === 'sheep') {
                            room.sheep.splice(room.sheep.indexOf(target), 1);
                            sec.wolves.splice(i, 1);
                            io.to(room.code).emit('sound', 'sheepBleat');
                            if (room.sheep.length === 0) {
                                room.gameRunning = false;
                                room.gameOverReason = "העדר נטרף!";
                                io.to(room.code).emit('sound', 'gameOver');
                                return;
                            }
                        } else if (targetType === 'followingSheep' && targetOwner) {
                            targetOwner.followingSheep.splice(targetOwner.followingSheep.indexOf(target), 1);
                            sec.wolves.splice(i, 1);
                            io.to(targetOwner.id).emit('sound', 'sheepBleat');
                        } else if (targetType === 'player' && w.attackCooldown <= 0) {
                            target.hp = Math.max(0, target.hp - 20);
                            target.hurtTimer = 15;
                            w.attackCooldown = 45;
                            io.to(target.id).emit('sound', 'playerHurt');

                            target.x = Math.max(15, Math.min(CANVAS_W - 15, target.x + Math.cos(moveAngle) * 18));
                            target.y = Math.max(15, Math.min(CANVAS_H - 15, target.y + Math.sin(moveAngle) * 18));
                        }
                    }
                }
            }
        }
    }
}

// לולאת סימולציה 30 FPS לכל החדרים
setInterval(() => {
    Object.values(rooms).forEach(room => {
        updateRoomLogic(room);
        io.to(room.code).emit('state', {
            day: room.day,
            isNight: room.isNight,
            phaseTimer: room.phaseTimer,
            totalSecondsSurvived: room.totalSecondsSurvived,
            wood: room.wood,
            rescuedCount: room.rescuedCount,
            gameRunning: room.gameRunning,
            gameOverReason: room.gameOverReason,
            frameCount: room.frameCount,
            worldSectors: room.worldSectors,
            sheep: room.sheep,
            players: room.players
        });
    });
}, 1000 / 30);

// טיימר יום ולילה (כל שנייה)
setInterval(() => {
    Object.values(rooms).forEach(room => {
        if (!room.gameRunning || Object.keys(room.players).length === 0) return;
        room.totalSecondsSurvived++;
        room.phaseTimer--;

        if (room.phaseTimer <= 0) {
            room.isNight = !room.isNight;
            room.phaseTimer = 30;
            if (room.isNight) {
                io.to(room.code).emit('sound', 'nightHowl');
                let homeWolfCount = 2 + room.day + Math.max(0, Object.keys(room.players).length - 1);
                for (let i = 0; i < homeWolfCount; i++) {
                    setTimeout(() => spawnWolfInSector(room, 0, 0), i * 3500);
                }
                for (let sx = MIN_SECTOR; sx <= MAX_SECTOR; sx++) {
                    for (let sy = MIN_SECTOR; sy <= MAX_SECTOR; sy++) {
                        if (sx === 0 && sy === 0) continue;
                        if (Math.random() < 0.45) {
                            setTimeout(() => spawnWolfInSector(room, sx, sy), 2000 + Math.random() * 8000);
                        }
                    }
                }
            } else {
                room.day++;
                io.to(room.code).emit('sound', 'morning');
                Object.values(room.players).forEach(p => {
                    if (p.hp <= 0) {
                        // חזרה לחיים בדיר בבוקר
                        p.hp = 60;
                        p.sector = { x: 0, y: 0 };
                        p.x = 400; p.y = 275;
                    } else {
                        p.hp = Math.min(p.maxHp, p.hp + 20);
                    }
                });

                spawnLostSheepRandomly(room, 3);

                for (let sx = MIN_SECTOR; sx <= MAX_SECTOR; sx++) {
                    for (let sy = MIN_SECTOR; sy <= MAX_SECTOR; sy++) {
                        const sec = getSectorData(room, sx, sy);
                        sec.wolves.length = 0;
                        const isHome = (sx === 0 && sy === 0);
                        spawnTreesInSector(room, sx, sy, isHome ? 2 : 4);
                        for (let i = sec.torches.length - 1; i >= 0; i--) {
                            sec.torches[i].life--;
                            if (sec.torches[i].life <= 0) sec.torches.splice(i, 1);
                        }
                    }
                }
            }
        }
    });
}, 1000);

// תקשורת מול הלקוחות (Socket.io)
io.on('connection', (socket) => {
    let currentRoomCode = null;

    socket.on('createRoom', ({ playerName }) => {
        const code = generateRoomCode();
        const room = createRoom(code);
        room.players[socket.id] = createPlayerObj(socket.id, 0, playerName);
        currentRoomCode = code;
        socket.join(code);
        socket.emit('joinedRoom', { roomCode: code, playerId: socket.id });
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const code = (roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room) {
            socket.emit('joinError', 'קוד חדר לא נמצא! בדוק שהקלדת נכון.');
            return;
        }
        const index = Object.keys(room.players).length;
        room.players[socket.id] = createPlayerObj(socket.id, index, playerName);
        currentRoomCode = code;
        socket.join(code);
        socket.emit('joinedRoom', { roomCode: code, playerId: socket.id });
    });

    socket.on('input', ({ keys, aimAngle }) => {
        const room = rooms[currentRoomCode];
        if (!room || !room.players[socket.id]) return;
        room.players[socket.id].keys = keys;
        room.players[socket.id].aimAngle = aimAngle;
    });

    socket.on('action', (type) => {
        const room = rooms[currentRoomCode];
        if (!room || !room.gameRunning) return;
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;

        const sec = getSectorData(room, p.sector.x, p.sector.y);

        if (type === 'chop' && !room.isNight) {
            for (let i = sec.trees.length - 1; i >= 0; i--) {
                let t = sec.trees[i];
                if (Math.hypot(p.x - t.x, p.y - t.y) < 52) {
                    t.hp--;
                    t.shake = 8;
                    room.wood += 2;
                    if (t.hp <= 0) {
                        sec.trees.splice(i, 1);
                        emitSoundToSector(room, p.sector.x, p.sector.y, 'treeFall');
                    } else {
                        emitSoundToSector(room, p.sector.x, p.sector.y, 'chop');
                    }
                    break;
                }
            }
        } else if (type === 'fence' && room.wood >= 3) {
            room.wood -= 3;
            sec.fences.push({ x: p.x, y: p.y, hp: 100, maxHp: 100, radius: 15 });
            emitSoundToSector(room, p.sector.x, p.sector.y, 'build');
        } else if (type === 'torch' && room.wood >= 5) {
            room.wood -= 5;
            sec.torches.push({ x: p.x, y: p.y, life: 2, seed: Math.random() * 100 });
            emitSoundToSector(room, p.sector.x, p.sector.y, 'build');
        } else if (type === 'craft' && room.wood >= 10 && p.swordUses === 0) {
            room.wood -= 10;
            p.swordUses = 3;
            socket.emit('sound', 'craft');
        } else if (type === 'attack' && p.swordUses > 0 && p.swingTimer <= 0) {
            p.swingAngle = p.aimAngle;
            p.swingTimer = 12;
            p.swordUses--;
            emitSoundToSector(room, p.sector.x, p.sector.y, 'swing');

            const attackRange = 75;
            let hitAny = false;
            for (let i = sec.wolves.length - 1; i >= 0; i--) {
                let w = sec.wolves[i];
                let dist = Math.hypot(w.x - p.x, w.y - p.y);
                if (dist <= attackRange) {
                    let angleToWolf = Math.atan2(w.y - p.y, w.x - p.x);
                    let diff = Math.abs(p.aimAngle - angleToWolf);
                    if (diff > Math.PI) diff = 2 * Math.PI - diff;
                    if (diff <= 1.25) {
                        sec.wolves.splice(i, 1);
                        hitAny = true;
                    }
                }
            }
            if (hitAny) {
                setTimeout(() => emitSoundToSector(room, p.sector.x, p.sector.y, 'wolfKill'), 60);
            }
        }
    });

    socket.on('restartRoom', () => {
        const room = rooms[currentRoomCode];
        if (!room) return;
        const oldPlayers = room.players;
        const newRoom = createRoom(currentRoomCode);
        Object.keys(oldPlayers).forEach((id, idx) => {
            newRoom.players[id] = createPlayerObj(id, idx, oldPlayers[id].name);
        });
    });

    socket.on('disconnect', () => {
        if (currentRoomCode && rooms[currentRoomCode]) {
            delete rooms[currentRoomCode].players[socket.id];
            if (Object.keys(rooms[currentRoomCode].players).length === 0) {
                delete rooms[currentRoomCode];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
