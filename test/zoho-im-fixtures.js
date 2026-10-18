// Builders that reproduce the HTML Zoho Desk generates for WhatsApp (instant
// message) chat transcripts - markup copied from real threads, with made-up
// names and numbers. Used to test src/conversation.js against the real format.

const ICON = '<img style="width:20px;height: 20px;" src="https://desk.zoho.com/support/ImageDisplay?downloadType=uploadedFile&fileName=1573578688486.png&blockId=x&zgId=y&mode=view">';

function header(author, time, width) {
  return `<div style="margin-bottom: 25px;word-break:break-all;word-wrap: break-word;${width ? 'width: 100%;' : ''}">        <div style="float: left;margin-right: 12px;margin-top: 5px;width: ${width ? 140 : 142}px;max-width:20%;text-align:right;">            <div style="font-size: 13px;margin-bottom: 3px;color: #000;">${author}</div>\n            <div style="font-size: 13px;color: #5A616F;">${time}</div>        </div>        <div style="float: left;max-width: 70%;">`;
}
const FOOT = '            <br>        </div>        <div style="clear: both;"></div>    </div>';
const BUBBLE = 'font-size: 14px;padding: 12px;line-height: 1.5;border-radius: 18px 18px 18px 0;color: #000;margin-bottom: 3px;width: fit-content;max-width: 100%;display: inline-block;overflow: auto;';

function customerText(author, time, text) {
  return `${header(author, time, true)}            <div style="background-color:#ebf3ff;${BUBBLE}">${text}</div>${FOOT}`;
}

function customerReply(author, time, quotedAuthor, quotedText, reply) {
  return `${header(author, time, false)}            <div style="background-color: #ebf3ff;${BUBBLE}">                <div style="background-color: #fff;padding: 8px;border-radius: 4px;">                    <div>                        <div>                            <div style="float:left;">                                ${ICON}                            </div>                            <div style="float: left;margin-left: 8px"><b style="font-size: 14px;">${quotedAuthor}</b></div>                            <div style="clear: both;"></div>                        </div>                        <div style="font-size: 14px;margin-left: 26px;">${quotedText} </div>                    </div>                </div>                <div style="margin-top: 6px">${reply}</div>            </div><br>        </div>        <div style="clear: both;"></div>    </div>`;
}

function option(label) {
  return `<div style="background-color: #fff;border: 1px solid transparent;border-radius: 10px;box-sizing: border-box;box-shadow: 0 2px 2px rgb(50 50 71 / 6%);font-size: 15px;line-height: 22px;margin-top: 10px;padding: 7px 12px;word-break: break-word;"> <div style="width: 200px;float: left;margin-top: 1px;word-break: break-word;">${label}</div><div style="clear: both;"></div></div>`;
}

function botOptions(author, time, prompt, options) {
  return `${header(author, time, true)}            <div style="background-color:#f6f8fb;${BUBBLE}"><div style="width: 260px;font-size: 15px;line-height: 1.5;"><div style="word-break:break-all; word-break:break-word;">${prompt}</div><div style="margin-top: 10px;">${options.map(option).join('')}</div></div></div>${FOOT}`;
}

function botPrompt(author, time, prompt) {
  return `${header(author, time, true)}            <div style="background-color:#f6f8fb;${BUBBLE}"><div style="width: 260px;font-size: 15px;line-height: 1.5;"><div style="word-break:break-all; word-break:break-word;">${prompt}</div><input style="width: 100%;height: 40px;background-color: #fff;" value="" disabled="" readonly=""> </div></div>${FOOT}`;
}

function businessText(author, time, text) {
  return `${header(author, time, true)}            <div style="background-color:#f6f8fb;${BUBBLE}">${text}</div>${FOOT}`;
}

function botRichText(author, time, text) {
  return `${header(author, time, true)}            <div style="background-color:#f6f8fb;${BUBBLE}"><div class="gcEditor ui-rte-editor-div ui-rte-editor" style="font-family:Arial, Helvetica, sans-serif; font-size:11pt; line-height:1.5"><p>${text}</p></div></div>${FOOT}`;
}

function imThread(id, createdTime, blocks) {
  return {
    id, createdTime, direction: 'in', channel: 'GAADI_INFO_CARE', contentType: 'text/html',
    source: { type: 'INSTANT_MESSAGE', appName: 'GaadiInfo Care' },
    author: { name: 'Test Customer', type: 'CONNECTION' },
    content: blocks.join('')
  };
}

function imItem(thread) {
  return { id: thread.id, type: 'thread', createdTime: thread.createdTime, direction: 'in', channel: 'GAADI_INFO_CARE', summary: '', source: thread.source, author: thread.author };
}

module.exports = { customerText, customerReply, businessText, botOptions, botPrompt, botRichText, imThread, imItem };
