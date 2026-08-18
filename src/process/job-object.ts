import koffi from "koffi";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_ALL = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION;

const kernel32 = koffi.load("kernel32.dll");

const CreateJobObjectW = kernel32.func(
  "void * __stdcall CreateJobObjectW(void *lpJobAttributes, str16 lpName)",
);
const SetInformationJobObject = kernel32.func(
  "bool __stdcall SetInformationJobObject(void *hJob, int JobObjectInfoClass, void *lpInfo, uint32 cbInfo)",
);
const AssignProcessToJobObject = kernel32.func(
  "bool __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)",
);
const OpenProcess = kernel32.func(
  "void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)",
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *hObject)");
const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");

const BasicLimitInformation = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
  PerProcessUserTimeLimit: "int64",
  PerJobUserTimeLimit: "int64",
  LimitFlags: "uint32",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32",
  Affinity: "uintptr",
  PriorityClass: "uint32",
  SchedulingClass: "uint32",
});

const IoCounters = koffi.struct("IO_COUNTERS", {
  ReadOperationCount: "uint64",
  WriteOperationCount: "uint64",
  OtherOperationCount: "uint64",
  ReadTransferCount: "uint64",
  WriteTransferCount: "uint64",
  OtherTransferCount: "uint64",
});

const ExtendedLimitInformation = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
  BasicLimitInformation,
  IoInfo: IoCounters,
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});

export type JobHandle = { ptr: unknown; close(): void };

export function createKillOnCloseJob(): JobHandle {
  const job = CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW failed (${GetLastError()})`);

  const info = Buffer.alloc(koffi.sizeof(ExtendedLimitInformation));
  const limitOffset = koffi.offsetof(ExtendedLimitInformation, "BasicLimitInformation")
    + koffi.offsetof(BasicLimitInformation, "LimitFlags");
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, limitOffset);

  const ok = SetInformationJobObject(
    job,
    JobObjectExtendedLimitInformation,
    info,
    info.length,
  );
  if (!ok) {
    const err = GetLastError();
    CloseHandle(job);
    throw new Error(`SetInformationJobObject failed (${err}), size=${info.length}, flags@${limitOffset}`);
  }
  return {
    ptr: job,
    close() {
      CloseHandle(job);
    },
  };
}

export function assignPidToJob(job: JobHandle, pid: number): void {
  const handle = OpenProcess(PROCESS_ALL, false, pid);
  if (!handle) throw new Error(`OpenProcess failed for pid ${pid} (${GetLastError()})`);
  try {
    const ok = AssignProcessToJobObject(job.ptr, handle);
    if (!ok) throw new Error(`AssignProcessToJobObject failed for pid ${pid} (${GetLastError()})`);
  } finally {
    CloseHandle(handle);
  }
}
