import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, Blob } from '@google/genai';
import { LANGUAGES } from './constants';
import { TranscriptionTurn } from './types';

// Helper to encode Uint8Array to base64
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper to create a Blob for the Gemini API
function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] < 0 ? data[i] * 32768 : data[i] * 32767;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

const MicrophoneIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-1 13.06A5.002 5.002 0 0 0 12 20a5 5 0 0 0 5-5v-1.06a7 7 0 0 1-8 0ZM19 10a1 1 0 0 1-2 0v-1a5 5 0 0 0-10 0v1a1 1 0 1 1-2 0V9a7 7 0 0 1 14 0v1Z"/>
  </svg>
);

const StopIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 7h10v10H7V7Z"/>
  </svg>
);

const LanguageSelector: React.FC<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}> = ({ id, value, onChange, disabled }) => (
  <div className="relative">
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full pl-3 pr-10 py-2 font-bold text-gray-900 bg-white border-2 border-black rounded-md appearance-none focus:outline-none focus:ring-2 ring-offset-2 ring-blue-500 disabled:opacity-50 disabled:bg-gray-400 disabled:cursor-not-allowed shadow-[4px_4px_0_#000] disabled:shadow-none transition-shadow"
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.name}
        </option>
      ))}
    </select>
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
    </div>
  </div>
);

const TranscriptionDisplay: React.FC<{ history: TranscriptionTurn[]; currentTurn: TranscriptionTurn | null }> = ({ history, currentTurn }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, currentTurn]);

  const allTurns = currentTurn ? [...history, currentTurn] : history;

  return (
    <div ref={scrollRef} className="flex-grow w-full max-w-4xl p-4 space-y-6 bg-gray-800 rounded-lg overflow-y-auto">
      {allTurns.length === 0 ? (
        <div className="flex items-center justify-center h-full text-gray-500">
          <p>Click the microphone to start transcribing and translating.</p>
        </div>
      ) : (
        allTurns.map((turn) => (
          <div
            key={turn.id}
            className={`transition-opacity duration-500 ${!turn.isFinal ? 'opacity-60' : 'opacity-100'}`}
          >
            <div className="p-4 bg-gray-900 rounded-lg">
              <p className="text-sm font-semibold text-blue-400 mb-1">Original</p>
              <p className="text-lg">{turn.original || '...'}</p>
            </div>
            <div className="mt-2 p-4 bg-gray-700 rounded-lg">
              <p className="text-sm font-semibold text-green-400 mb-1">Translation</p>
              <p className="text-lg">{turn.translated || '...'}</p>
            </div>
          </div>
        ))
      )}
    </div>
  );
};


export default function App() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'error'>('idle');
  const [sourceLanguage, setSourceLanguage] = useState<string>('es');
  const [targetLanguage, setTargetLanguage] = useState<string>('en');
  const [history, setHistory] = useState<TranscriptionTurn[]>([]);
  const [currentTurn, setCurrentTurn] = useState<TranscriptionTurn | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);

  const stopListening = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current?.disconnect();
    audioContextRef.current?.close().catch(console.error);
    sessionPromiseRef.current?.then((session) => session.close());

    micStreamRef.current = null;
    processorRef.current = null;
    audioContextRef.current = null;
    sessionPromiseRef.current = null;

    setStatus('idle');
    if (currentTurn && currentTurn.original) {
      setHistory(prev => [...prev, { ...currentTurn, isFinal: true }]);
    }
    setCurrentTurn(null);
  }, [currentTurn]);

  // Effect to clean up resources when the popup is closed (component unmounts)
  useEffect(() => {
    return () => {
      if (status === 'listening' || status === 'connecting') {
        stopListening();
      }
    };
  }, [status, stopListening]);

  const translateText = useCallback(async (text: string, sourceLang: string, targetLang: string): Promise<string> => {
    if (!text || !aiRef.current) return '';
    try {
      const sourceLangName = LANGUAGES.find(l => l.code === sourceLang)?.name || 'the source language';
      const targetLangName = LANGUAGES.find(l => l.code === targetLang)?.name || 'the target language';
      const response = await aiRef.current.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Translate the following text from ${sourceLangName} to ${targetLangName}: "${text}"`,
      });
      return response.text;
    } catch (error) {
      console.error('Translation error:', error);
      return '[Translation failed]';
    }
  }, []);

  const startListening = useCallback(async () => {
    setStatus('connecting');
    setErrorMessage('');
    setCurrentTurn(null);
    setHistory([]);

    try {
      if (!process.env.API_KEY) {
        throw new Error("API_KEY environment variable not set.");
      }
      aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });

      micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      
      sessionPromiseRef.current = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            const source = audioContextRef.current!.createMediaStreamSource(micStreamRef.current!);
            processorRef.current = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            source.connect(processorRef.current);
            processorRef.current.connect(audioContextRef.current!.destination);

            processorRef.current.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            setStatus('listening');
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setCurrentTurn(prev => ({
                id: prev?.id ?? Date.now(),
                original: (prev?.original || '') + text,
                translated: prev?.translated || '',
                isFinal: false
              }));
            }

            if (message.serverContent?.turnComplete) {
              setCurrentTurn(prevTurn => {
                if (prevTurn && prevTurn.original) {
                  const finalTurn = { ...prevTurn, isFinal: true };
                  setHistory(prevHistory => [...prevHistory, finalTurn]);
                  translateText(finalTurn.original, sourceLanguage, targetLanguage).then(translation => {
                    setHistory(prevHistory => prevHistory.map(h => 
                      h.id === finalTurn.id ? { ...h, translated: translation } : h
                    ));
                  });
                }
                return null; // Start a new turn
              });
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('API Error:', e);
            setErrorMessage('An API error occurred. Please try again.');
            setStatus('error');
            stopListening();
          },
          onclose: () => {
            console.log('API connection closed.');
            if (status !== 'idle' && status !== 'error') {
               setStatus('idle');
            }
          },
        }
      });
    } catch (error) {
      console.error('Failed to start listening:', error);
      const message = error instanceof Error ? error.message : 'An unknown error occurred.';
      setErrorMessage(`Failed to start: ${message}`);
      setStatus('error');
    }
  }, [stopListening, translateText, sourceLanguage, targetLanguage, status]);
  
  const handleToggleRecording = useCallback(() => {
    if (status === 'listening' || status === 'connecting') {
      stopListening();
    } else {
      startListening();
    }
  }, [status, startListening, stopListening]);

  const getStatusInfo = (): { text: string; color: string } => {
    switch (status) {
      case 'idle':
        return { text: 'Ready to translate', color: 'text-gray-400' };
      case 'connecting':
        return { text: 'Connecting to mic...', color: 'text-yellow-400' };
      case 'listening':
        return { text: 'Listening...', color: 'text-green-400 animate-pulse' };
      case 'error':
        return { text: 'Error', color: 'text-red-500' };
      default:
        return { text: 'Standby', color: 'text-gray-400' };
    }
  };
  
  const statusInfo = getStatusInfo();

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-gray-900 text-white p-4">
      <header className="text-center mb-4">
        <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-green-500">
          Voice Translator
        </h1>
        <p className={`mt-1 text-sm ${statusInfo.color}`}>{statusInfo.text}</p>
        {status === 'error' && <p className="text-red-400 mt-1 text-xs">{errorMessage}</p>}
      </header>
      
      <div className="w-full max-w-4xl mx-auto mb-2 p-2 bg-gray-800 border border-gray-600 rounded-md">
        <h2 className="font-bold text-sm mb-1 text-center text-gray-200">How to Use</h2>
        <ol className="list-decimal list-inside text-gray-400 text-xs space-y-1 text-center">
          <li>Select 'From' and 'To' languages.</li>
          <li>Press the microphone to start recording.</li>
          <li>Press the stop button for the final translation.</li>
        </ol>
      </div>

      <main className="flex-grow flex flex-col items-center gap-4 min-h-0">
        <TranscriptionDisplay history={history} currentTurn={currentTurn} />
      </main>

      <footer className="mt-4 flex flex-col items-center justify-center gap-4">
         <div className="flex items-center justify-center gap-2 w-full max-w-2xl">
           <div className="flex-1">
            <label htmlFor="source-lang" className="block text-center mb-1 text-xs font-medium text-gray-400">From</label>
            <LanguageSelector 
              id="source-lang"
              value={sourceLanguage} 
              onChange={setSourceLanguage}
              disabled={status !== 'idle'}
            />
          </div>
           <div className="flex-1">
            <label htmlFor="target-lang" className="block text-center mb-1 text-xs font-medium text-gray-400">To</label>
            <LanguageSelector 
              id="target-lang"
              value={targetLanguage} 
              onChange={setTargetLanguage}
              disabled={status !== 'idle'}
            />
          </div>
        </div>
        <button
          onClick={handleToggleRecording}
          disabled={status === 'connecting'}
          className={`relative flex items-center justify-center w-20 h-20 rounded-md font-bold border-2 border-black transition-all duration-150 ease-in-out focus:outline-none focus:ring-4 focus:ring-opacity-50 transform active:shadow-none active:translate-x-1 active:translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:transform-none
            ${status === 'listening' 
              ? 'bg-red-500 text-white shadow-[6px_6px_0px_#000] hover:shadow-none hover:-translate-x-1 hover:-translate-y-1 focus:ring-red-400 disabled:bg-red-400' 
              : 'bg-blue-600 text-white shadow-[6px_6px_0px_#000] hover:shadow-none hover:-translate-x-1 hover:-translate-y-1 focus:ring-blue-400 disabled:bg-blue-400'}`
          }
        >
          {status === 'listening' && (
            <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75"></span>
          )}
          {status === 'listening' ? <StopIcon className="w-10 h-10" /> : <MicrophoneIcon className="w-10 h-10" />}
        </button>
      </footer>
    </div>
  );
}
