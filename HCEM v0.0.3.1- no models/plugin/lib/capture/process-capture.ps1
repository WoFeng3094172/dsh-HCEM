# 按进程采集系统声音（Application Loopback）—— 完整录音版
# 用法：powershell -File process-capture.ps1 PROCESS_ID OUT_WAV [SECONDS]
#
# 关键（来自方案文档的修正）：
#   进程过滤用 IMMDevice::Activate + PROPVARIANT(VT_BLOB -> AUDIOCLIENT_ACTIVATION_PARAMS)，
#   不用 ActivateAudioInterfaceAsync（它不支持复杂激活参数）。
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace HcemCap {

  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  public enum PROCESS_LOOPBACK_MODE { INCLUDE_TARGET_PROCESS_TREE = 0, EXCLUDE_TARGET_PROCESS_TREE = 1 }

  [StructLayout(LayoutKind.Sequential)]
  public struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    public uint TargetProcessId;
    public int ProcessLoopbackMode;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct AUDIOCLIENT_ACTIVATION_PARAMS {
    public int ActivationType;
    public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BLOB {
    public uint cbSize;
    public IntPtr pBlobData;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public BLOB blob;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  public struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out object devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, ref PROPVARIANT activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    int OpenPropertyStore(int stgmAccess, out object store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity,
                   IntPtr format, IntPtr audioSessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out int flags, out long devicePos, out long qpcPos);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  public static class Capture {
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("combase.dll")] static extern int RoInitialize(int initType);
    [DllImport("combase.dll")] static extern void RoUninitialize();

    const int CLSCTX_ALL = 23;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int VT_BLOB = 65;

    public static string Run(int procId, string outWav, double seconds) {
      string result = null;
      Thread t = new Thread(() => {
        int ro = RoInitialize(1);
        CoInitializeEx(IntPtr.Zero, 0x0);
        IntPtr blobPtr = IntPtr.Zero;
        IntPtr fmtPtr = IntPtr.Zero;
        try {
          if (ro != 0 && ro != 1) {
            result = "{\"ok\":false,\"stage\":\"roinit\",\"hr\":\"0x" + ro.ToString("X8") + "\"}";
            return;
          }

          var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
          IMMDevice device;
          int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device);
          if (hr != 0) { result = "{\"ok\":false,\"stage\":\"endpoint\",\"hr\":\"0x" + hr.ToString("X8") + "\"}"; return; }

          AUDIOCLIENT_ACTIVATION_PARAMS p = new AUDIOCLIENT_ACTIVATION_PARAMS();
          p.ActivationType = 1;
          p.ProcessLoopbackParams.TargetProcessId = (uint)procId;
          p.ProcessLoopbackParams.ProcessLoopbackMode = (int)PROCESS_LOOPBACK_MODE.INCLUDE_TARGET_PROCESS_TREE;

          int size = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
          blobPtr = Marshal.AllocHGlobal(size);
          Marshal.StructureToPtr(p, blobPtr, false);

          PROPVARIANT pv = new PROPVARIANT();
          pv.vt = VT_BLOB;
          pv.blob.cbSize = (uint)size;
          pv.blob.pBlobData = blobPtr;

          Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
          object iface;
          hr = device.Activate(ref iidClient, CLSCTX_ALL, ref pv, out iface);
          if (hr != 0) { result = "{\"ok\":false,\"stage\":\"activate\",\"hr\":\"0x" + hr.ToString("X8") + "\"}"; return; }
          IAudioClient client = (IAudioClient)iface;

          // 进程回环要求自己指定格式：48kHz 立体声 32bit float
          WAVEFORMATEX wf = new WAVEFORMATEX();
          wf.wFormatTag = 3;          // IEEE float
          wf.nChannels = 2;
          wf.nSamplesPerSec = 48000;
          wf.wBitsPerSample = 32;
          wf.nBlockAlign = (ushort)(wf.nChannels * wf.wBitsPerSample / 8);
          wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;
          wf.cbSize = 0;
          fmtPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEFORMATEX)));
          Marshal.StructureToPtr(wf, fmtPtr, false);

          // 1 秒缓冲
          long bufDuration = 10000000L;
          hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufDuration, 0, fmtPtr, IntPtr.Zero);
          if (hr != 0) { result = "{\"ok\":false,\"stage\":\"initialize\",\"hr\":\"0x" + hr.ToString("X8") + "\"}"; return; }

          Guid iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
          object capObj;
          hr = client.GetService(ref iidCap, out capObj);
          if (hr != 0) { result = "{\"ok\":false,\"stage\":\"getservice\",\"hr\":\"0x" + hr.ToString("X8") + "\"}"; return; }
          IAudioCaptureClient cap = (IAudioCaptureClient)capObj;

          hr = client.Start();
          if (hr != 0) { result = "{\"ok\":false,\"stage\":\"start\",\"hr\":\"0x" + hr.ToString("X8") + "\"}"; return; }

          // 采样：48k / 立体声 / float32 → 转 16k 单声道 int16
          var outSamples = new System.Collections.Generic.List<short>();
          int sampleRate = 48000;
          int channels = 2;
          int ratio = sampleRate / 16000;  // 3
          int acc = 0;
          double accSum = 0;
          DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
          while (DateTime.UtcNow < deadline) {
            Thread.Sleep(20);
            uint packet;
            while (true) {
              hr = cap.GetNextPacketSize(out packet);
              if (hr != 0 || packet == 0) break;
              IntPtr data;
              uint frames;
              int flags;
              long dpos, qpos;
              hr = cap.GetBuffer(out data, out frames, out flags, out dpos, out qpos);
              if (hr != 0 || frames == 0) break;
              int count = (int)frames * channels;
              float[] tmp = new float[count];
              Marshal.Copy(data, tmp, 0, count);
              cap.ReleaseBuffer(frames);
              for (int i = 0; i < frames; i++) {
                float mono = (tmp[i * channels] + tmp[i * channels + 1]) * 0.5f;
                accSum += mono;
                acc++;
                if (acc >= ratio) {
                  double v = accSum / acc;
                  if (v > 1.0) v = 1.0; else if (v < -1.0) v = -1.0;
                  outSamples.Add((short)(v * 32767.0));
                  acc = 0; accSum = 0;
                }
              }
            }
          }
          client.Stop();

          // 写 wav（16k 单声道 16bit）
          using (var fs = new FileStream(outWav, FileMode.Create, FileAccess.Write))
          using (var bw = new BinaryWriter(fs)) {
            int dataLen = outSamples.Count * 2;
            bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
            bw.Write(36 + dataLen);
            bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
            bw.Write(16);
            bw.Write((short)1);
            bw.Write((short)1);
            bw.Write(16000);
            bw.Write(16000 * 2);
            bw.Write((short)2);
            bw.Write((short)16);
            bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
            bw.Write(dataLen);
            foreach (short s in outSamples) bw.Write(s);
          }

          result = "{\"ok\":true,\"samples\":" + outSamples.Count + ",\"seconds\":" + (outSamples.Count / 16000.0).ToString("F2") + "}";
        } catch (Exception e) {
          result = "{\"ok\":false,\"stage\":\"exception\",\"error\":\"" + e.Message.Replace("\"", "'") + "\"}";
        } finally {
          if (blobPtr != IntPtr.Zero) Marshal.FreeHGlobal(blobPtr);
          if (fmtPtr != IntPtr.Zero) Marshal.FreeHGlobal(fmtPtr);
          CoUninitialize();
          RoUninitialize();
        }
      });
      t.SetApartmentState(ApartmentState.MTA);
      t.IsBackground = true;
      t.Start();
      if (!t.Join((int)((seconds + 15) * 1000))) return "{\"ok\":false,\"stage\":\"thread-timeout\"}";
      return result;
    }
  }
}
"@

$procId = [int]$args[0]
$outWav = if ($args.Count -ge 2) { $args[1] } else { "E:\HCEM\.proc-capture.wav" }
$seconds = if ($args.Count -ge 3) { [double]$args[2] } else { 3.0 }

if ($procId -le 0) { Write-Output '{"ok":false,"error":"need process id"}'; exit 1 }

try {
  $out = [HcemCap.Capture]::Run($procId, $outWav, $seconds)
  Write-Output $out
} catch {
  Write-Output ('{"ok":false,"stage":"ps-exception","error":"' + $_.Exception.Message.Replace('"', "'") + '"}')
}
