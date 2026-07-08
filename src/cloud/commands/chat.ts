/**
 * Chat commands for interactive document conversations
 */

import { Command } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { get, post, OkraApiError, EXIT_CODES } from '../lib/client.js';
import { success, error, info, formatOutput } from '../../lib/output.js';
import { createSpinner, withSpinner } from '../../lib/progress.js';
import { getDefaultFormat } from '../../lib/config.js';
import type { ChatMessage, ChatResponse, Document, OutputFormat } from '../../types.js';

export function createChatCommand(): Command {
  const chat = new Command('chat')
    .description('Chat with documents using AI')
    .argument('<documentUuid>', 'Document UUID to chat with')
    .option('-m, --message <message>', 'Single message (non-interactive mode)')
    .option('-o, --output <format>', 'Output format (text, json)', 'text')
    .option('--system <prompt>', 'Custom system prompt')
    .action(async (documentUuid, options) => {
      // Verify document exists
      try {
        const doc = await withSpinner(
          'Loading document',
          () => get<Document>(`api/library/document`, { uuid: documentUuid })
        );
        info(`Chatting with: ${doc.file_name}`);
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          error(`Document not found: ${documentUuid}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }

      // Single message mode
      if (options.message) {
        const response = await sendMessage(documentUuid, options.message, options.system);

        if (options.output === 'json') {
          console.log(formatOutput(response, 'json'));
        } else {
          console.log(response.message.content);
        }
        return;
      }

      // Interactive mode
      await interactiveChat(documentUuid, options.system);
    });

  return chat;
}

/**
 * Send a single message to the chat API
 */
async function sendMessage(
  documentUuid: string,
  message: string,
  systemPrompt?: string
): Promise<ChatResponse> {
  const spinner = createSpinner('Thinking...');
  spinner.start();

  try {
    const response = await post<ChatResponse>('api/v1/messages', {
      document_uuid: documentUuid,
      message,
      system_prompt: systemPrompt,
    });

    spinner.stop();
    return response;
  } catch (err) {
    spinner.fail('Failed to get response');
    throw err;
  }
}

/**
 * Interactive chat session
 */
async function interactiveChat(documentUuid: string, systemPrompt?: string): Promise<void> {
  const history: ChatMessage[] = [];

  console.log();
  console.log(chalk.bold('okraPDF Document Chat'));
  console.log(chalk.dim('Type your questions about the document. Use /quit to exit.'));
  console.log(chalk.dim('Commands: /quit, /clear, /history, /export'));
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('You: '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (input.startsWith('/')) {
      await handleCommand(input, history, documentUuid, rl);
      return;
    }

    // Add user message to history
    const userMessage: ChatMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };
    history.push(userMessage);

    try {
      const response = await sendMessage(documentUuid, input, systemPrompt);

      // Add assistant message to history
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message.content,
        timestamp: new Date().toISOString(),
      };
      history.push(assistantMessage);

      console.log();
      console.log(chalk.green('Assistant:'), response.message.content);

      // Show output files if any
      if (response.output_files && response.output_files.length > 0) {
        console.log();
        console.log(chalk.dim('Generated files:'));
        for (const file of response.output_files) {
          console.log(chalk.dim(`  - ${file.filename}`));
        }
      }

      console.log();
    } catch (err) {
      if (err instanceof OkraApiError) {
        console.log(chalk.red('Error:'), err.message);
      } else {
        console.log(chalk.red('Error:'), 'Failed to get response');
      }
      console.log();
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log();
    console.log(chalk.dim('Chat session ended'));
    process.exit(0);
  });
}

/**
 * Handle chat commands
 */
async function handleCommand(
  input: string,
  history: ChatMessage[],
  documentUuid: string,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const [command, ...args] = input.slice(1).split(' ');

  switch (command.toLowerCase()) {
    case 'quit':
    case 'exit':
    case 'q':
      rl.close();
      break;

    case 'clear':
      history.length = 0;
      console.log(chalk.dim('Chat history cleared'));
      console.log();
      rl.prompt();
      break;

    case 'history':
      if (history.length === 0) {
        console.log(chalk.dim('No chat history'));
      } else {
        console.log();
        console.log(chalk.bold('Chat History'));
        console.log(chalk.dim('─'.repeat(50)));
        for (const msg of history) {
          const role = msg.role === 'user' ? chalk.cyan('You') : chalk.green('Assistant');
          console.log(`${role}: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
        }
      }
      console.log();
      rl.prompt();
      break;

    case 'export':
      const format = args[0] || 'json';
      const filename = `chat-${documentUuid.slice(0, 8)}-${Date.now()}.${format}`;

      try {
        const { writeFileSync } = await import('fs');

        if (format === 'json') {
          writeFileSync(filename, JSON.stringify(history, null, 2));
        } else if (format === 'md' || format === 'markdown') {
          const md = history.map(msg => {
            const role = msg.role === 'user' ? '**You**' : '**Assistant**';
            return `${role}: ${msg.content}`;
          }).join('\n\n');
          writeFileSync(filename.replace(/\.\w+$/, '.md'), md);
        } else {
          console.log(chalk.red('Unknown format. Use: json, md'));
          rl.prompt();
          return;
        }

        console.log(chalk.green('✓'), `Exported to: ${filename}`);
      } catch (err) {
        console.log(chalk.red('Failed to export:'), err instanceof Error ? err.message : 'Unknown error');
      }
      console.log();
      rl.prompt();
      break;

    case 'help':
      console.log();
      console.log(chalk.bold('Available Commands'));
      console.log(chalk.dim('─'.repeat(30)));
      console.log('/quit, /exit, /q  - Exit chat');
      console.log('/clear           - Clear chat history');
      console.log('/history         - Show chat history');
      console.log('/export [format] - Export history (json, md)');
      console.log('/help            - Show this help');
      console.log();
      rl.prompt();
      break;

    default:
      console.log(chalk.yellow('Unknown command:'), command);
      console.log(chalk.dim('Use /help for available commands'));
      console.log();
      rl.prompt();
  }
}
