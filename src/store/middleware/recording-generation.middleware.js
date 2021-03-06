import * as Tone from 'tone';
import toWav from 'audiobuffer-to-wav';
import piecesById from '@pieces/by-id';
import START_RECORDING_GENERATION from '@store/actions/types/start-recording-generation.type';
import QUEUE_RECORDING_GENERATION from '@store/actions/types/queue-recording-generation.type';
import REMOVE_RECORDING_GENERATION from '@store/actions/types/remove-recording-generation.type';
import RECORDING_GENERATION_COMPLETE from '@store/actions/types/recording-generation-complete.type';
import recordingGenerationComplete from '@store/actions/creators/recording-generation-complete.creator';
import startRecordingGeneration from '@store/actions/creators/start-recording-generation.creator';
import stop from '@store/actions/creators/stop.creator';
import library from '@pieces/library';
import noop from '@utils/noop';

const renderOffline = (piece, durationInSeconds) => {
  const { sampleRate } = Tone.context;
  const originalContext = Tone.context;
  if (!originalContext.Transport) {
    originalContext.Transport = Tone.Transport;
  }
  const offlineContext = new Tone.OfflineContext(
    2,
    durationInSeconds,
    sampleRate
  );
  Tone.setContext(offlineContext);

  /*
   * SUPER HACK ALERT―TRULY DISGUSTING
   * In some cases, Tone will disconnect audio nodes too early.
   * For example, when stopping a BufferSource Tone calls disconnect on a
   * couple different AudioNodes. This happens before the audio is actually
   * rendered. So, delay those disconnects until after the audio has been rendered.
   */

  // const fnAttempts = [];
  // const restoreFns = [];
  // const hackFn = (target, fnName, returnValue) => {
  //   const originalFn = target[fnName];
  //   restoreFns.push(() => {
  //     target[fnName] = originalFn;
  //   });
  //   target[fnName] = function hacked(...args) {
  //     fnAttempts.push(originalFn.bind(this, ...args));
  //     return returnValue;
  //   };
  // };
  //
  // hackFn(Tone, 'disconnect', Tone);
  // hackFn(window.AudioBufferSourceNode.prototype, 'disconnect');
  // hackFn(Tone.ToneBufferSource.prototype, 'dispose');

  return piece
    .activate({
      context: offlineContext,
      destination: offlineContext.destination,
      sampleLibrary: library,
      onProgress: noop,
    })
    .then(([deactivate, schedule]) => {
      const end = schedule();
      Tone.Transport.start();
      const renderPromise = offlineContext.render();
      return renderPromise.then(recordingBuffer => {
        //fnAttempts.concat(restoreFns).forEach(fn => fn());
        end();
        Tone.Transport.stop();
        Tone.Transport.cancel();
        deactivate();
        Tone.setContext(originalContext);
        return recordingBuffer;
      });
    });
};

const recordingGenerationMiddleware = store => next => {
  return action => {
    if (action.type === START_RECORDING_GENERATION) {
      const { generatedRecordings, isPlaying } = store.getState();
      const recording = generatedRecordings[action.payload];
      const piece = piecesById[recording.pieceId];
      if (typeof piece !== 'undefined') {
        if (isPlaying) {
          store.dispatch(stop());
        }
        renderOffline(piece, recording.lengthInMinutes * 60).then(buffer => {
          const wavData = toWav(buffer);
          const blob = new window.Blob([new DataView(wavData)], {
            type: 'audio/wav',
          });
          const objectUrl = window.URL.createObjectURL(blob);
          store.dispatch(
            recordingGenerationComplete({
              objectUrl,
              recordingId: recording.recordingId,
            })
          );
        });
      }
    } else if (action.type === REMOVE_RECORDING_GENERATION) {
      const { generatedRecordings } = store.getState();
      const { url } = generatedRecordings[action.payload];
      if (typeof url === 'string' && url !== '') {
        window.URL.revokeObjectURL(url);
      }
    }
    const result = next(action);
    if (
      action.type === QUEUE_RECORDING_GENERATION ||
      action.type === RECORDING_GENERATION_COMPLETE
    ) {
      const { generatedRecordings } = store.getState();
      const recordings = Reflect.ownKeys(generatedRecordings).map(
        recordingId => generatedRecordings[recordingId]
      );
      const inCompleteRecordings = recordings.filter(({ url }) => url === '');
      const startNextRecording =
        inCompleteRecordings.length > 0 &&
        inCompleteRecordings.every(recording => !recording.isInProgress);
      if (startNextRecording) {
        const nextRecording = inCompleteRecordings.reduce(
          (oldestRecording, recording) =>
            recording.queuedAtTime < oldestRecording.queuedAtTime
              ? recording
              : oldestRecording,
          {
            queuedAtTime: Infinity,
          }
        );
        store.dispatch(startRecordingGeneration(nextRecording.recordingId));
      }
    }
    return result;
  };
};

export default recordingGenerationMiddleware;
