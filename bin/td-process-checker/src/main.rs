use std::env;
use std::process;

use serde::Deserialize;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
	EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, SendMessageTimeoutW,
	GW_OWNER, SMTO_ABORTIFHUNG, WM_NULL,
};
use wmi::{COMLibrary, WMIConnection};

#[derive(Deserialize, Debug)]
#[serde(rename = "Win32_Process")]
#[serde(rename_all = "PascalCase")]
struct Win32Process {
	process_id: u32,
	parent_process_id: u32,
	command_line: Option<String>,
	__path: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "PascalCase")]
struct OwnerResult {
	_return_value: Option<u32>,
	user: Option<String>,
	domain: Option<String>,
}

struct ProcessInfo {
	pid: u32,
	ppid: u32,
	user: String,
	domain: String,
	cmdline: String,
}

struct HungInfo {
	responding: bool,
	has_window: bool,
}

fn get_owner(wmi: &WMIConnection, process: &Win32Process) -> (String, String) {
	let empty: () = ();
	match wmi.exec_instance_method::<Win32Process, _, OwnerResult>(
		"GetOwner",
		&process.__path,
		empty,
	) {
		Ok(owner) => (
			owner.user.unwrap_or_default(),
			owner.domain.unwrap_or_default(),
		),
		Err(_) => (String::new(), String::new()),
	}
}

fn enumerate_processes(wmi: &WMIConnection) -> Vec<ProcessInfo> {
	let query = "SELECT ProcessId, ParentProcessId, CommandLine, __Path FROM Win32_Process WHERE Name = 'TiddlyDesktop.exe'";

	let processes: Vec<Win32Process> = wmi.raw_query(query).unwrap_or_default();

	processes
		.iter()
		.map(|p| {
			let (user, domain) = get_owner(wmi, p);
			ProcessInfo {
				pid: p.process_id,
				ppid: p.parent_process_id,
				user,
				domain,
				cmdline: p.command_line.clone().unwrap_or_default(),
			}
		})
		.collect()
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
	let data = &mut *(lparam.0 as *mut (u32, Option<HWND>));
	let target_pid = data.0;

	let mut window_pid = 0u32;
	GetWindowThreadProcessId(hwnd, Some(&mut window_pid));

	if window_pid == target_pid {
		if IsWindowVisible(hwnd).as_bool() {
			if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
				if owner.0.is_null() {
					data.1 = Some(hwnd);
				}
			}
		}
	}

	BOOL::from(true)
}

fn find_main_window(pid: u32) -> Option<HWND> {
	unsafe {
		let mut data = (pid, None::<HWND>);
		let _ = EnumWindows(Some(enum_windows_callback), LPARAM(&mut data as *mut _ as isize));
		data.1
	}
}

fn is_process_responding(hwnd: HWND) -> bool {
	unsafe {
		let mut result = 0usize;
		let _ = SendMessageTimeoutW(
			hwnd,
			WM_NULL,
			WPARAM(0),
			LPARAM(0),
			SMTO_ABORTIFHUNG,
			100,
			Some(&mut result),
		);
		result != 0
	}
}

fn get_hung_info(pid: u32) -> HungInfo {
	match find_main_window(pid) {
		Some(hwnd) => {
			let responding = is_process_responding(hwnd);
			HungInfo {
				responding,
				has_window: true,
			}
		}
		None => HungInfo {
			responding: true,
			has_window: false,
		},
	}
}

fn print_list(processes: &[ProcessInfo]) {
	for p in processes {
		println!(
			"{}\t{}\t{}\t{}\t{}",
			p.pid, p.ppid, p.user, p.domain, p.cmdline
		);
	}
}

fn print_hung(processes: &[ProcessInfo]) {
	for p in processes {
		let hung = get_hung_info(p.pid);
		println!(
			"{}\t{}\t{}\t{}\t{}\t{}\t{}",
			p.pid,
			p.ppid,
			hung.responding,
			hung.has_window,
			p.user,
			p.domain,
			p.cmdline
		);
	}
}

fn main() {
	let args: Vec<String> = env::args().collect();
	if args.len() < 2 {
		eprintln!("Usage: td-process-checker <list|hung>");
		process::exit(1);
	}

	let mode = &args[1];

	let wmi = match COMLibrary::new().and_then(|com| WMIConnection::new(com)) {
		Ok(conn) => conn,
		Err(e) => {
			eprintln!("Failed to connect to WMI: {}", e);
			process::exit(1);
		}
	};

	let processes = enumerate_processes(&wmi);

	match mode.as_str() {
		"list" => print_list(&processes),
		"hung" => print_hung(&processes),
		_ => {
			eprintln!("Unknown mode: {}", mode);
			process::exit(1);
		}
	}
}
