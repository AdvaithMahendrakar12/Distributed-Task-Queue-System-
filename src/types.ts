
// to define the type of task

// thinking of generate_video 
// so need to process the video 
export type VideoJob = {
    id: string
    type: 'process_video'
    payload: {
        videoId: string
        videoUrl: string
        resolution: '720p' | '1080p'
        outputFormat: 'mp4' | 'webm'
    }
    createdAt: string
    status: 'pending' | 'processing' | 'completed' | 'failed'
}




