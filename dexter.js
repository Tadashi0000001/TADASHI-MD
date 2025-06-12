const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const fs = require('fs').promises;
const P = require('pino');
const path = require('path');
const os = require('os');
const express = require('express');
const { File } = require('megajs');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const { performance } = require('perf_hooks');

async function withRetry(operation, maxRetries = config.MAX_RETRIES || 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (err.message.includes('socket hang up') && attempt < maxRetries) {
        console.warn(`Attempt ${attempt} failed with socket hang up. Retrying after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

const runtime = (seconds) => {
  seconds = Number(seconds);
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
};

const mediaCache = new Map();


const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        remote_jid TEXT NOT NULL,
        message_text TEXT,
        message_type TEXT,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP WITH TIME ZONE,
        deleted_by TEXT,
        sri_lanka_time TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo'),
        auto_reply_sent BOOLEAN DEFAULT FALSE
      )
    `);

    const imageColumnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'messages' AND column_name = 'image_url'
    `);
    if (imageColumnCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE messages ADD COLUMN image_url TEXT`);
      console.log('Added image_url column to messages table');
    }

    const autoReplyColumnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'messages' AND column_name = 'auto_reply_sent'
    `);
    if (autoReplyColumnCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE messages ADD COLUMN auto_reply_sent BOOLEAN DEFAULT FALSE`);
      console.log('Added auto_reply_sent column to messages table');
    }

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}

initializeDatabase();

async function downloadSessionFile() {
  const sessionPath = path.join(__dirname, 'sessions/creds.json');
  try {
    if (await fs.access(sessionPath).then(() => true).catch(() => false)) {
      console.log('Session file already exists');
      return;
    }
    if (!config.SESSION_ID) {
      console.error('Please add your session to SESSION_ID env variable!');
      process.exit(1);
    }
    const sessdata = config.SESSION_ID.replace('TADASHI-ID=', '');
    const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
    await withRetry(() => new Promise((resolve, reject) => {
      file.download((err, data) => {
        if (err) return reject(err);
        fs.writeFile(sessionPath, data)
          .then(() => {
            console.log('Session downloaded ✅');
            resolve();
          })
          .catch(reject);
      });
    }));
  } catch (err) {
    console.error('Session download error:', err.message);
    process.exit(1);
  }
}

downloadSessionFile();

const app = express();
const port = config.PORT || 9090;
const ownerNumber = config.OWNER_NUMBER ? config.OWNER_NUMBER.split(',') : ['94789958225'];
const restrictedNumber = config.RESTRICTED_NUMBER || '94789958225@s.whatsapp.net';
const statusTriggers = config.STATUS_TRIGGERS ? config.STATUS_TRIGGERS.split(',') : [
  'send', 'Send', 'Seve', 'Ewpm', 'ewpn', 'Dapan', 'dapan',
  'oni', 'Oni', 'save', 'Save', 'ewanna', 'Ewanna', 'ewam',
  'Ewam', 'sv', 'Sv', 'දාන්න', 'එවම්න'
];
const groupLink = config.GROUP_LINK;
const tempDir = path.join(os.tmpdir(), 'cache-temp');
const startTime = performance.now();
const IMGBB_API_KEY = config.IMGBB_API_KEY || '3839e303da7b555ec5d574e53eb836d2';

app.use(express.static(path.join(__dirname, 'public')));

let replyRules = {};

async function loadJsonFile() {
  try {
    const replyData = await fs.readFile(path.join(__dirname, 'reply.json'), 'utf-8');
    replyRules = JSON.parse(replyData);
    console.log('reply.json loaded successfully');
  } catch (err) {
    console.error('Error loading reply.json:', err.message);
  }
}

loadJsonFile();

async function reloadJsonFile() {
  try {
    const renderUrl = config.RENDER_JSON_URL;
    if (!renderUrl) throw new Error('RENDER_JSON_URL not set in config');
    
    const response = await withRetry(() => axios.get(renderUrl));
    const replyData = response.data;
    
    await fs.writeFile(path.join(__dirname, 'reply.json'), JSON.stringify(replyData, null, 2));
    await loadJsonFile();
    console.log('reply.json reloaded successfully');
    return '✅ reply.json reloaded successfully';
  } catch (err) {
    console.error('Error reloading reply.json:', err.message);
    return '❌ Failed to reload reply.json';
  }
}

async function ensureTempDir() {
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (err) {
    console.error('Temp directory creation error:', err.message);
  }
}

ensureTempDir();

setInterval(async () => {
  try {
    const files = await fs.readdir(tempDir);
    for (const file of files) {
      await fs.unlink(path.join(tempDir, file)).catch(err => 
        console.error('File deletion error:', err.message)
      );
    }
  } catch (err) {
    console.error('Temp directory cleanup error:', err.message);
  }
}, 5 * 60 * 1000);

async function uploadToImgbb(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) {
      console.error('Invalid buffer for imgbb upload');
      return null;
    }
    const formData = new FormData();
    formData.append('image', buffer.toString('base64'));
    
    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      params: { key: IMGBB_API_KEY },
      headers: formData.getHeaders()
    });
    
    console.log('imgbb upload successful:', response.data.data.url);
    return response.data.data.url;
  } catch (err) {
    if (err.response && err.response.status === 400 && err.response.data.error.code === 100) {
      console.warn('imgbb rate limit reached, skipping upload');
      return null;
    }
    console.error('imgbb upload error:', err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

async function fetchMedia(source) {
  try {
    let buffer;
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const response = await withRetry(() => axios.get(source, { responseType: 'arraybuffer' }));
      buffer = Buffer.from(response.data);
    } else {
      buffer = await fs.readFile(source);
    }
    console.log(`Successfully fetched media from ${source}`);
    return buffer;
  } catch (err) {
    console.error('Media fetch error:', err.message);
    return null;
  }
}

const getRandom = (ext = '') => {
  return `${Math.floor(Math.random() * 10000)}${ext}`;
};

const getExtension = (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    console.error('Invalid or undefined buffer in getExtension');
    return 'jpg';
  }
  const magicNumbers = {
    jpg: 'ffd8ffe0',
    png: '89504e47',
    mp4: '00000018',
  };
  const magic = buffer.toString('hex', 0, 4);
  return Object.keys(magicNumbers).find(key => magicNumbers[key] === magic) || 'jpg';
};

async function getStatus() {
  try {
    const runtime = performance.now() - startTime;
    const seconds = Math.floor(runtime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const totalMessages = await pool.query('SELECT COUNT(*) FROM messages');
    const imageMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'imageMessage'`);
    const videoMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'videoMessage'`);
    const voiceMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'audioMessage'`);
    const callMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'call'`);
    const deletedMessages = await pool.query(`
      SELECT deleted_by, COUNT(*) as count 
      FROM messages WHERE is_deleted = TRUE 
      GROUP BY deleted_by
    `);
    const autoReplies = await pool.query(`SELECT COUNT(*) FROM messages WHERE auto_reply_sent = TRUE`);

    return {
      runtime: `${hours}h ${minutes % 60}m ${seconds % 60}s`,
      totalMessages: parseInt(totalMessages.rows[0].count),
      imageMessages: parseInt(imageMessages.rows[0].count),
      videoMessages: parseInt(videoMessages.rows[0].count),
      voiceMessages: parseInt(voiceMessages.rows[0].count),
      callMessages: parseInt(callMessages.rows[0].count),
      deletedMessages: deletedMessages.rows.map(row => ({
        deletedBy: row.deleted_by,
        count: parseInt(row.count)
      })),
      autoRepliesSent: parseInt(autoReplies.rows[0].count)
    };
  } catch (err) {
    console.error('Status query error:', err.message);
    return null;
  }
}

async function handleDelete(clear = false) {
  try {
    if (clear) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM messages');
        await client.query('COMMIT');
        console.log('Database cleared successfully');
        return { message: 'Database cleared successfully' };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const { rows } = await pool.query(`
        SELECT message_id, sender_jid, remote_jid, message_text, image_url, deleted_by, deleted_at, sri_lanka_time
        FROM messages 
        WHERE is_deleted = TRUE AND image_url IS NOT NULL
      `);
      console.log(`Retrieved ${rows.length} deleted messages with images`);
      return { deletedMessages: rows };
    }
  } catch (err) {
    console.error('Delete operation error:', err.message);
    return { error: 'Failed to process delete operation' };
  }
}

let whatsappConn;
async function connectToWA() {
  console.log('Connecting to WhatsApp...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions'));
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      browser: Browsers.macOS('Safari'),
      auth: state,
      version
    });

    conn.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log('Connected successfully');
        whatsappConn = conn;
        await sendConnectedMessage(conn);
        if (groupLink) {
          try {
            const inviteCode = groupLink.split('/').pop();
            const groupData = await withRetry(() => conn.groupAcceptInvite(inviteCode));
            console.log(`Successfully joined group: ${groupData.gid}`);
         
            const groupMetadata = await withRetry(() => conn.groupMetadata(groupData.gid));
            const admins = groupMetadata.participants
              .filter(p => p.admin)
              .map(p => p.id);
            
            const connectedMessage = `🤖 *TADASHI-MD Bot Connected!* 🤖\n\n` +
                                  `🕒 *Connected At:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}\n` +
                                  `📌 *Group:* ${groupMetadata.subject}\n` +
                                  `✅ Bot is now active and ready to serve!`;
            
            for (const admin of admins) {
              await withRetry(() => conn.sendMessage(admin, { text: connectedMessage }));
              console.log(`Sent connected message to admin: ${admin}`);
            }
          } catch (err) {
            console.error('Group join error:', err.message);
          }
        }

        if (config.ALWAYS_ONLINE === 'true') {
          await conn.sendPresenceUpdate('available');
        } else if (config.ALWAYS_ONLINE === 'false') {
          await conn.sendPresenceUpdate('unavailable');
        }

        if (config.AUTO_BIO === 'true') {
          await conn.updateProfileStatus(
            `𝙷𝙴𝚈, 𝙵𝚄𝚃𝚄𝚁𝙴 𝙻𝙴𝙰𝙳𝙴𝚁𝚂! 🌟 ᴛᴀᴅᴀꜱʜɪ-𝙼𝙳 𝙸𝚂 𝙷𝙴𝚁𝙴 𝚃𝙾 𝙸𝙽𝚂𝙿𝙸𝚁𝙴 𝙰𝙽𝙳 𝙻𝙴𝙰𝙳, 𝚃𝙷𝙰𝙽𝙺𝚂 𝚃𝙾 ᴛᴀᴅᴀꜱʜɪ, 𝙸𝙽𝙲. 🚀 ${runtime(process.uptime())}`
          ).catch(err => console.error('Bio update error:', err.message));
        }
      } else if (connection === 'close') {
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconnecting...');
          setTimeout(connectToWA, 5000);
        } else {
          console.log('Logged out. Please scan QR code again.');
        }
      }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('group-participants.update', async (update) => {
      try {
        const { id, participants, action } = update;
        const groupMetadata = await withRetry(() => conn.groupMetadata(id));
        const groupName = groupMetadata.subject;
        let message = '';
        switch (action) {
          case 'add':
            message = `📌 User joined: ${participants.map(p => `@${p.split('@')[0]}`).join(', ')}\n`;
            message += `\n🏷️ Group: ${groupName}`;
            break;
          case 'remove':
            message = `🚪 User left: ${participants.map(p => `@${p.split('@')[0]}`).join(', ')}\n`;
            message += `\n🏷️ Group: ${groupName}`;
            break;
          case 'promote':
            message = `⭐ Admin promoted: ${participants.map(p => `@${p.split('@')[0]}`).join(', ')}\n`;
            message += `\n🏷️ Group: ${groupName}`;
            break;
          case 'demote':
            message = `🔻 Admin demoted: ${participants.map(p => `@${p.split('@')[0]}`).join(', ')}\n`;
            message += `\n🏷️ Group: ${groupName}`;
            break;
        }
        if (message) {
          for (const owner of ownerNumber) {
            await withRetry(() => conn.sendMessage(`${owner}@s.whatsapp.net`, { text: message }));
            console.log(`Sent group update to ${owner}: ${message}`);
          }
        }
      } catch (err) {
        console.error('Group event error:', err.message);
      }
    });

    conn.ev.on('messages.upsert', async ({ messages }) => {
      const mek = messages[0];
      if (!mek.message) return;

      try {
        const from = mek.key.remoteJid;
        if (config.AUTO_TYPING === 'true') {
          await conn.sendPresenceUpdate('composing', from);
        }
        if (config.AUTO_RECORDING === 'true') {
          await conn.sendPresenceUpdate('recording', from);
        }

        if (mek.key.remoteJid === 'status@broadcast' && config.AUTO_STATUS_SEEN === true) {
          await withRetry(() => conn.readMessages([mek.key]));
          return;
        }

        let messageContent = mek.message;
        let messageType = getContentType(messageContent);
        let imageUrl = null;

        if (messageType === 'ephemeralMessage') {
          messageContent = messageContent.ephemeralMessage.message;
          messageType = getContentType(messageContent);
        }
        if (messageType === 'viewOnceMessageV2') {
          messageContent = messageContent.viewOnceMessageV2.message;
          messageType = getContentType(messageContent);
        }

        let messageText = '';
        if (messageType === 'conversation') {
          messageText = messageContent.conversation;
        } else if (messageType === 'extendedTextMessage') {
          messageText = messageContent.extendedTextMessage.text;
        } else if (['imageMessage', 'videoMessage', 'audioMessage'].includes(messageType)) {
          try {
            const buffer = await withRetry(() => 
              downloadMediaMessage(mek, 'buffer', {}, {
                logger: P({ level: 'silent' }),
                reuploadRequest: conn.updateMediaMessage
              }));
            if (messageType === 'imageMessage') {
              imageUrl = await uploadToImgbb(buffer);
            }
            messageText = JSON.stringify({
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype
            });
            mediaCache.set(mek.key.id, {
              type: messageType,
              buffer,
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype,
              imageUrl,
              timestamp: Date.now()
            });
            const now = Date.now();
            for (const [id, { timestamp }] of mediaCache) {
              if (now - timestamp > 60 * 60 * 1000) {
                mediaCache.delete(id);
              }
            }
          } catch (err) {
            console.error('Media caching error:', {
              messageId: mek.key.id,
              messageType,
              error: err.message,
              stack: err.stack
            });
            messageText = JSON.stringify({
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype
            });
          }
        } else {
          messageText = JSON.stringify(messageContent);
        }

        const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });

        let autoReplySent = false;
        try {
          await pool.query(
            `INSERT INTO messages 
            (message_id, sender_jid, remote_jid, message_text, message_type, image_url, sri_lanka_time, auto_reply_sent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              mek.key.id,
              mek.key.participant || mek.key.remoteJid,
              mek.key.remoteJid,
              messageText,
              messageType,
              imageUrl,
              sriLankaTime,
              autoReplySent
            ]
          );
        } catch (err) {
          console.error('Database insert error:', err.message);
          return;
        }

        if (config.AUTO_READ === 'true') {
          await withRetry(() => conn.readMessages([mek.key]));
          console.log(`Marked message from ${mek.key.remoteJid} as read`);
        }

        const senderJid = mek.key.participant || mek.key.remoteJid;
        const pushName = mek.pushName || 'Unknown';
        const userId = senderJid.split('@')[0];
        let senderDpUrl = 'https://i.imgur.com/default-profile.jpg';
        try {
          senderDpUrl = await conn.profilePictureUrl(senderJid, 'image') || senderDpUrl;
        } catch (err) {
          console.warn(`Failed to fetch profile picture for ${senderJid}: ${err.message}`);
        }

        if (messageText && statusTriggers.includes(messageText)) {
          if (!mek.message.extendedTextMessage || !mek.message.extendedTextMessage.contextInfo.quotedMessage) {
            await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
              text: '*Please Mention status*'
            }, { quoted: mek }));
            return;
          }

          const quotedMessage = mek.message.extendedTextMessage.contextInfo.quotedMessage;
          const isStatus = mek.message.extendedTextMessage.contextInfo.remoteJid === 'status@broadcast';
          
          if (!isStatus) {
            await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
              text: '*Quoted message is not a status*'
            }, { quoted: mek }));
            return;
          }

          const quotedMessageType = getContentType(quotedMessage);
          
          if (quotedMessageType === 'imageMessage') {
            try {
              const nameJpg = getRandom('');
              const buff = await withRetry(() => 
                downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, {
                  logger: P({ level: 'silent' }),
                  reuploadRequest: conn.updateMediaMessage
                }));
              if (!Buffer.isBuffer(buff)) {
                throw new Error('Invalid buffer received for image');
              }
              const ext = getExtension(buff);
              const filePath = path.join(tempDir, `${nameJpg}.${ext}`);
              await fs.writeFile(filePath, buff);
              const caption = quotedMessage.imageMessage.caption || '';
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                image: buff,
                caption: caption
              }, { quoted: mek }));
              await fs.unlink(filePath).catch(err => console.error('File deletion error:', err.message));
            } catch (err) {
              console.error('Image status save error:', err.message);
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                text: `❌ Failed to save status image: ${err.message}`
              }, { quoted: mek }));
            }
          } else if (quotedMessageType === 'videoMessage') {
            try {
              const nameJpg = getRandom('');
              const buff = await withRetry(() => 
                downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, {
                  logger: P({ level: 'silent' }),
                  reuploadRequest: conn.updateMediaMessage
                }));
              if (!Buffer.isBuffer(buff)) {
                throw new Error('Invalid buffer received for video');
              }
              const ext = getExtension(buff);
              const filePath = path.join(tempDir, `${nameJpg}.${ext}`);
              await fs.writeFile(filePath, buff);
              const caption = quotedMessage.videoMessage.caption || '';
              const buttonMessage = {
                video: buff,
                mimetype: 'video/mp4',
                fileName: `${mek.key.id}.mp4`,
                caption: caption,
                headerType: 4
              };
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, buttonMessage, { quoted: mek }));
              await fs.unlink(filePath).catch(err => console.error('File deletion error:', err.message));
            } catch (err) {
              console.error('Video status save error:', err.message);
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                text: `❌ Failed to save status video: ${err.message}`
              }, { quoted: mek }));
            }
          } else {
            await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
              text: '*Quoted status is not an image or video*'
            }, { quoted: mek }));
          }
          return;
        }

        if (
          messageText &&
          !messageText.startsWith('.') &&
          !mek.key.fromMe &&
          senderJid !== restrictedNumber &&
          mek.key.remoteJid !== restrictedNumber
        ) {
          for (const rule of replyRules.rules) {
            let isMatch = false;
            if (rule.pattern) {
              try {
                const regex = new RegExp(rule.pattern, 'i');
                isMatch = regex.test(messageText);
              } catch (err) {
                console.error(`Invalid regex pattern in rule "${rule.trigger}": ${err.message}`);
                isMatch = rule.trigger && messageText.toLowerCase().includes(rule.trigger.toLowerCase());
              }
            } else {
              isMatch = rule.trigger && messageText.toLowerCase().includes(rule.trigger.toLowerCase());
            }

            if (isMatch) {
              autoReplySent = true;
              await pool.query(
                `UPDATE messages SET auto_reply_sent = TRUE WHERE message_id = $1`,
                [mek.key.id]
              );
              for (const response of rule.response) {
                if (response.delay) {
                  await new Promise(resolve => setTimeout(resolve, response.delay));
                }
                const contextInfo = {
                  quotedMessage: mek.message,
                  forwardingScore: 999,
                  isForwarded: true
                };
                let content = response.content;
                let caption = response.caption;
                let url = response.url;
                if (content) {
                  content = content.replace('${pushname}', pushName)
                                  .replace('${userid}', userId)
                                  .replace('${senderdpurl}', senderDpUrl);
                }
                if (caption) {
                  caption = caption.replace('${pushname}', pushName)
                                  .replace('${userid}', userId)
                                  .replace('${senderdpurl}', senderDpUrl);
                }
                if (url) {
                  url = url.replace('${pushname}', pushName)
                          .replace('${userid}', userId)
                          .replace('${senderdpurl}', senderDpUrl);
                }
                switch (response.type) {
                  case 'text':
                    await withRetry(() => conn.sendMessage(mek.key.remoteJid, { 
                      text: content,
                      contextInfo
                    }, { quoted: mek }));
                    break;
                  case 'image':
                    const imageBuffer = await fetchMedia(url);
                    if (imageBuffer) {
                      await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                        image: imageBuffer,
                        caption: caption || '',
                        contextInfo
                      }, { quoted: mek }));
                    }
                    break;
                  case 'video':
                    const videoBuffer = await fetchMedia(url);
                    if (videoBuffer) {
                      await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                        video: videoBuffer,
                        caption: caption || '',
                        contextInfo
                      }, { quoted: mek }));
                    }
                    break;
                  case 'voice':
                    const voiceBuffer = await fetchMedia(url);
                    if (voiceBuffer) {
                      await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                        audio: voiceBuffer,
                        mimetype: 'audio/mpeg',
                        ptt: true,
                        contextInfo
                      }, { quoted: mek }));
                    }
                    break;
                }
              }
              break;
            }
          }
        }

        if (messageText && messageText.startsWith('.')) {
          const [command, ...args] = messageText.split(' ');

          switch (command.toLowerCase()) {
            case '.ping':
              const pingTime = performance.now();
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                text: `🏓 Pong! Response time: ${Math.round(performance.now() - pingTime)}ms`
              }, { quoted: mek }));
              break;

            case '.runtime':
              const runtime = performance.now() - startTime;
              const seconds = Math.floor(runtime / 1000);
              const minutes = Math.floor(seconds / 60);
              const hours = Math.floor(minutes / 60);
              await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                text: `⏰ Bot Runtime: ${hours}h ${minutes % 60}m ${seconds % 60}s`
              }, { quoted: mek }));
              break;

            case '.reload':
              if (ownerNumber.includes(senderJid.split('@')[0])) {
                const result = await reloadJsonFile();
                await withRetry(() => conn.sendMessage(mek.key.remoteJid, { text: result }, { quoted: mek }));
              } else {
                await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                  text: '🚫 Only owners can use the .reload command.'
                }, { quoted: mek }));
              }
              break;

            case '.delete':
              if (ownerNumber.includes(senderJid.split('@')[0])) {
                const clear = args[0]?.toLowerCase() === 'clear';
                const result = await handleDelete(clear);
                if (clear && !result.error) {
                  await withRetry(() => conn.sendMessage(mek.key.remoteJid, { 
                    text: '✅ Database cleared successfully'
                  }, { quoted: mek }));
                } else if (!clear && result.deletedMessages) {
                  const message = result.deletedMessages.length > 0
                    ? `🗑️ Found ${result.deletedMessages.length} deleted messages with images:\n` +
                      result.deletedMessages.map(m => 
                        `ID: ${m.message_id}\nSender: ${m.sender_jid}\nImage: ${m.image_url}\nDeleted By: ${m.deleted_by}\nDeleted At: ${m.sri_lanka_time}`
                      ).join('\n\n')
                    : '🗑️ No deleted messages with images found.';
                  await withRetry(() => conn.sendMessage(mek.key.remoteJid, { text: message }, { quoted: mek }));
                } else {
                  await withRetry(() => conn.sendMessage(mek.key.remoteJid, { 
                    text: '❌ Failed to process delete operation'
                  }, { quoted: mek }));
                }
              } else {
                await withRetry(() => conn.sendMessage(mek.key.remoteJid, {
                  text: '🚫 Only owners can use the .delete command.'
                }, { quoted: mek }));
              }
              break;
          }
        }
      } catch (err) {
        console.error('Message processing error:', err.message);
      }
    });

    conn.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update.message === null) {
          await handleDeletedMessage(conn, update);
        }
      }
    });

    return conn;
  } catch (err) {
    console.error('WhatsApp connection error:', err.message);
    setTimeout(connectToWA, 5000);
  }
}

async function sendConnectedMessage(conn) {
  try {
    const dbStatus = await checkDatabaseConnection();
    const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
    
    const message = `🤖 *Bot Connected Successfully!* 🤖\n\n` +
                   `🕒 *Sri Lanka Time:* ${sriLankaTime}\n` +
                   `📊 *Database Status:* ${dbStatus}\n` +
                   `💻 *Host:* ${os.hostname()}\n\n` +
                   `✅ Ready to receive messages!`;
    
    for (const owner of ownerNumber) {
      await withRetry(() => conn.sendMessage(`${owner}@s.whatsapp.net`, { text: message }));
    }
  } catch (err) {
    console.error('Connected message error:', err.message);
  }
}

async function checkDatabaseConnection() {
  try {
    await pool.query('SELECT 1');
    return 'Connected ✅';
  } catch (err) {
    console.error('Database connection check error:', err.message);
    return 'Disconnected ❌';
  }
}

async function handleDeletedMessage(conn, update) {
  try {
    const { key } = update;
    const { remoteJid, id, participant } = key;
    const deleterJid = participant || remoteJid;

    await pool.query(
      `UPDATE messages 
       SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $1
       WHERE message_id = $2`,
      [deleterJid, id]
    );

    const { rows } = await pool.query(
      `SELECT * FROM messages WHERE message_id = $1`,
      [id]
    );

    if (rows.length > 0) {
      const originalMessage = rows[0];
      const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
      const cachedMedia = mediaCache.get(id);

      if (cachedMedia && ['imageMessage', 'videoMessage', 'audioMessage'].includes(originalMessage.message_type)) {
        let messageContent = {};
        
        if (originalMessage.message_type === 'imageMessage' && originalMessage.image_url) {
          messageContent = {
            image: { url: originalMessage.image_url },
            caption: cachedMedia.caption || ''
          };
        } else {
          messageContent = {
            [originalMessage.message_type]: {
              buffer: cachedMedia.buffer,
              caption: cachedMedia.caption || '',
              mimetype: cachedMedia.mimetype
            }
          };
        }

        await withRetry(() => conn.sendMessage(deleterJid, messageContent));

        const alertMessage = `🔔 *TADASHI PRIVATE ASSISTANT* 🔔\n\n` +
                           `📩 *Original Sender:* ${originalMessage.sender_jid}\n` +
                           `🗑️ *Deleted By:* ${deleterJid}\n` +
                           `🕒 *Deleted At (SL):* ${sriLankaTime}\n` +
                           `📝 *Caption:* ${cachedMedia.caption || 'No caption'}\n\n` +
                           `*❮ ᴛᴀᴅᴀꜱʜɪ ᴘᴏᴡᴇʀ ʙʏ ᴀɴᴛɪ ᴅᴇʟᴇᴛ ❯*`;

        await withRetry(() => conn.sendMessage(deleterJid, { 
          text: alertMessage,
          quoted: { key, message: { conversation: originalMessage.message_text } }
        }));
      } else {
        let messageText = originalMessage.message_text;
        if (['imageMessage', 'videoMessage', 'audioMessage'].includes(originalMessage.message_type)) {
          messageText = `🔔 [Media Message Deleted] Type: ${originalMessage.message_type}, Caption: ${JSON.parse(originalMessage.message_text).caption || 'No caption'}`;
        }
        await withRetry(() => conn.sendMessage(deleterJid, {
          text: messageText
        }));

        const alertMessage = `🔔 *TADASHI PRIVATE ASSISTANT* 🔔\n\n` +
                           `📩 *Original Sender:* ${originalMessage.sender_jid}\n` +
                           `🗑️ *Deleted By:* ${deleterJid}\n` +
                           `🕒 *Deleted At (SL):* ${sriLankaTime}\n\n` +
                           `*❮ ᴛᴀᴅᴀꜱʜɪ ᴘᴏᴡᴇʀ ʙʏ ᴀɴᴛɪ ᴅᴇʟᴇᴛ ❯*`;

        await withRetry(() => conn.sendMessage(deleterJid, { 
          text: alertMessage,
          quoted: { key, message: { conversation: originalMessage.message_text } }
        }));
      }
    }
  } catch (err) {
    console.error('Deleted message handler error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', async (req, res) => {
  const status = await getStatus();
  if (status) {
    res.json(status);
  } else {
    res.status(500).json({ error: 'Failed to retrieve status' });
  }
});

app.get('/reload', async (req, res) => {
  const result = await reloadJsonFile();
  res.json({ message: result });
});

app.get('/delete', async (req, res) => {
  const clear = req.query.clear === 'true';
  const result = await handleDelete(clear);
  res.json(result);
});

app.get('/send-message', async (req, res) => {
  const { number, message } = req.query;

  if (!number || !message) {
    return res.status(400).json({ error: 'Missing number or message parameter' });
  }

  const phoneNumber = number.replace(/[^0-9]/g, '');
  if (!phoneNumber.match(/^\d{10,12}$/)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  if (!whatsappConn || !whatsappConn.user) {
    return res.status(503).json({ error: 'WhatsApp connection not established' });
  }

  const jid = `${phoneNumber}@s.whatsapp.net`;
  const imagePath = path.join(__dirname, 'public', 'TADASHI.jpg');

  try {
    const imageBuffer = await fetchMedia(imagePath);
    if (!imageBuffer) {
      return res.status(500).json({ error: 'Failed to load TADASHI.jpg' });
    }

    const contextInfo = {
      forwardingScore: 999,
      isForwarded: true
    };

    await withRetry(() =>
      whatsappConn.sendMessage(jid, {
        image: imageBuffer,
        caption: decodeURIComponent(message),
        contextInfo
      })
    );
    console.log(`Image message sent to ${jid} with caption: ${message}`);
    res.json({ success: true, message: `Image sent to ${phoneNumber}` });
  } catch (err) {
    console.error('Image send error:', err.message);
    res.status(500).json({ error: 'Failed to send image', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  connectToWA();
});